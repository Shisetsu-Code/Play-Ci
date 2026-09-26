# 3 Oaks implementation record

## Scope

This document records how Play-Ci was evolved from a generic Playwright click/network probe into a protocol-first wagering cataloger for 3 Oaks while preserving browser/UI evidence as a separate validation layer.

The current target set is stored in `analysis/targets.txt` and contains 110 3 Oaks game URLs.

The objective is to determine, for every target:

- every normal/selectable bet;
- line/factor combinations that alter effective stake;
- every feature-buy mode;
- every fixed-price buy;
- every booster / ante-bet mode;
- all provider-declared actions that could affect wagering;
- the runtime evidence status for each special mode.

The catalog must never lose a provider-declared feature only because a browser hook, screenshot path, renderer, or GitHub runner failed.

## Architecture that survived testing

The final design is deliberately layered:

```text
targets.txt
   |
   v
Playwright opens real game
   |
   v
capture bootstrap/start traffic
   |
   v
3 Oaks declaration parser
   |
   +--> normal bet catalog
   +--> buy modes
   +--> boosters
   +--> action list
   +--> client family
   +--> execution blueprints
   |
   v
optional runtime proof
   |
   +--> real visible click when a visual profile exists
   +--> native client method when it is known to emit the real wire request
   +--> protocol replay fallback in a fresh browser session
   |
   v
captured/returned gsc=play request + response
   |
   v
per-mode runtime status
```

Discovery and runtime proof are intentionally separate. Discovery determines completeness. Runtime proof increases confidence in the UI/wire mapping.

## 3 Oaks discovery source

The authoritative discovery input is the real `start` response captured from the game.

Important fields currently consumed:

```text
context.actions
context.available_buy_bonus
context.available_booster
context.spins.bet_per_line
context.spins.lines

settings.bets
settings.bet_factor
settings.lines
settings.currency_format.denominator
settings.buy_bonus_prices
settings.buy_bonus_price
settings.freespins_buying_price
settings.booster_prices
```

The implementation lives primarily in:

```text
src/providers/three-oaks.js
```

### Modern buy format

A common game exposes:

```json
{
  "actions": ["spin", "buy_spin"],
  "available_buy_bonus": [1, 2, 3],
  "buy_bonus_prices": {
    "1": 30,
    "2": 75,
    "3": 150
  }
}
```

These become three independent declared buy modes.

### Legacy buy format

Some clients expose prices through an array:

```text
settings.buy_bonus_price = [50, 100, ...]
```

When `buy_spin` is an available action and no modern declared modes are present, Play-Ci normalizes that array to zero-based provider modes:

```text
mode 0 -> 50x
mode 1 -> 100x
```

The normalized protocol records:

```text
buy_mode_encoding = legacy_zero_based_index
buy_price_source = settings.buy_bonus_price
```

### Fixed buy format

Some games expose a fixed purchase through:

```text
settings.freespins_buying_price
```

When `buy_spin` is available but no selectable modes are declared, this is represented as one fixed buy with no `selected_mode`.

### Orphan metadata

A game can expose buy-looking metadata while `buy_spin` is not an available action.

Those values are preserved as:

```text
raw_available_buy_bonus
orphaned_buy_bonus
```

but they are not promoted to executable buy modes. This prevents false positives.

## Normal bet computation

The provider exposes raw bet values plus a factor and a currency denominator.

For each valid factor:

```text
display_bet = raw_bet * bet_factor / denominator
```

If multiple factors/line configurations exist, Play-Ci creates a separate `by_factor` entry and also a deduplicated sorted `display_bets` union.

The generated catalog contains:

```text
raw_bets
bet_factors
lines
denominator
display_bets
bets_by_factor
```

The implementation is `threeOaksEffectiveBets()` and `enumerateThreeOaksBaseBets()`.

## Special-mode request shapes

### Buy

Observed/common wire shape:

```json
{
  "command": "play",
  "action": {
    "name": "buy_spin",
    "params": {
      "bet_per_line": 5,
      "lines": 25,
      "selected_mode": 1
    }
  }
}
```

Not every client uses every parameter. Fixed/legacy games may omit `selected_mode` or encode the selection differently.

### Booster / ante bet

Observed/common shape:

```json
{
  "command": "play",
  "action": {
    "name": "spin",
    "params": {
      "bet_per_line": 5,
      "lines": 25,
      "ante_bet": 1.75,
      "selected_mode": 1
    }
  }
}
```

The expected `ante_bet` is taken from `settings.booster_prices`, not guessed from UI text.

### Transport detail

3 Oaks commonly sends JSON bodies with:

```text
Content-Type: text/plain
```

Using `application/json` can cause a CORS preflight that the demo endpoint does not accept. This was discovered while validating CoinUp Volcano.

## Early reference games

### 4_super_clover_pots

Server declarations:

```text
buy modes: 1, 2
buy prices: 75x, 200x
boosters: 1, 2, 3
booster prices: 1.75x, 3x, 7.5x
```

This game was also used to visually map the Ratpack economic popup.

### coinup_volcano

Server declarations:

```text
buy modes: 1, 2, 3
buy prices: 30x, 75x, 150x
boosters: none
```

All three buys were independently accepted by the demo server in early protocol validation.

## Client families

The 110-game set exposed these client families:

```text
goreel
kendoo
ratpack
hraymo
enjoy
```

A major lesson was that `TestActions` is not a provider-wide stable API. Different families and generations contain:

- useful methods;
- stubs;
- different argument conventions;
- different mode numbering;
- methods that return without producing a wire request.

Therefore the existence or success of an internal method is never treated as proof by itself.

## Visual profiles

Durable visual layouts are stored in:

```text
analysis/visual-profiles.json
```

A profile is keyed by:

```text
client_family + number of buys + number of boosters
```

Profiles currently include visually mapped layouts for:

- Goreel buy-2;
- Enjoy buy-2;
- Hraymo buy-2;
- Ratpack buy-2 + booster-3.

A profile stores:

- startup dismiss coordinate;
- economic/bonus button coordinate;
- buy-option coordinates;
- booster-option coordinates;
- spin coordinate;
- wait timings;
- representative game;
- evidence run IDs.

Profiles are execution aids. The actual proof remains the request/response caused by the click.

## Kendoo renderer limitation

Kendoo is the main renderer-specific exception encountered on GitHub-hosted Chromium.

Repeated tests included:

- default headless Chromium;
- SwiftShader/ANGLE variants;
- software rendering flags;
- headed Chromium under Xvfb;
- long initialization waits.

In these runner environments, Kendoo could expose runtime objects while the visible frame remained stuck in a loading state. The analyzer therefore does not delete Kendoo declarations when visual proof is unavailable.

When visual proof is unavailable, a fresh-session protocol replay can be used as a lower proof tier to confirm the server accepts the declared mode. This is transport proof, not UI reachability proof.

## Runtime proof levels

The current analyzer distinguishes proof strength.

### VALIDATED_VISUAL

A real viewport click sequence emitted the expected `gsc=play` request and the server accepted it.

This is the strongest UI-to-wire proof.

### VALIDATED_NATIVE

A known game-client method emitted the expected wire request and the server accepted it.

This proves the loaded client can produce the request, but it is weaker than a visible click.

### VALIDATED_PROTOCOL_REPLAY

A mode was declared in `start`; in a fresh browser session the exact demo endpoint accepted a replayed `gsc=play` for that declared mode.

This proves protocol validity, not UI reachability.

### VALIDATED_REQUEST_RECOGNIZED / VALIDATED_REPLAY_RECOGNIZED

The semantic request was recognized but could not complete for a non-structural runtime reason such as demo funds or another provider runtime condition.

### DECLARED_*

The mode remains declared but runtime proof was unavailable because the client did not initialize, no request was emitted, or an automation capability was absent.

### DEFERRED_PROVIDER_BLOCK

The provider began returning 403/429 and runtime execution was stopped/deferred.

## Why the architecture changed

### Failed approach: execute everything from one runner

An early 110-game run opened too many fresh sessions and attempted roughly 230 runtime actions from one GitHub runner/IP.

Result:

- mass 403 responses;
- useful discovery data was mixed with transport blocking;
- 0 runtime validations were trustworthy from that run.

Fix:

- split discovery from runtime;
- lower concurrency;
- batch validation;
- add delays;
- add a 403/429 circuit breaker;
- shard exhaustive work across multiple runners;
- preserve declarations even if runtime proof is deferred.

### Failed approach: universal TestActions adapter

Different client families did not implement `TestActions` consistently.

Fix:

- family-aware runtime helpers;
- visual profiles;
- native methods only when they generate real traffic;
- replay fallback for transport proof.

### Failed approach: total network-idle readiness

Some WebGL clients keep background traffic open.

Fix:

- readiness is based on concrete client objects/capabilities;
- post-click activity is observed directly;
- network quiet is used only as a bounded settling aid.

### Failed approach: assuming UI ordinal equals provider mode

Calling the first UI item with zero-based index caused false negatives for games whose provider modes are `1,2,...`.

Fix:

- provider mode IDs come from `start`;
- UI ordinals are kept separately;
- a mapping is only accepted when the emitted request proves it.

## Exhaustive workflow

The exhaustive workflow is:

```text
.github/workflows/exhaustive-3oaks.yml
```

It splits the target list into 12 shards.

Each shard runs:

```text
ANALYSIS_RUNTIME_VALIDATION=1
ANALYSIS_RUNTIME_MODE=hybrid
ANALYSIS_VALIDATE_ALL_MODES=1
ANALYSIS_VALIDATE_EVERY_TARGET=1
ANALYSIS_DISCOVERY_CONCURRENCY=1
ANALYSIS_VALIDATION_CONCURRENCY=1
```

The merge job runs:

```text
scripts/merge-exhaustive-results.js
```

and produces:

```text
exhaustive-report.json
bet-catalog.json
bet-catalog.csv
summary.md
unfinished-targets.txt
```

## Normal analysis workflow

The normal analysis workflow is:

```text
.github/workflows/analyze-targets.yml
```

It is triggered by changing:

```text
analysis/trigger.txt
```

Normal analysis intentionally keeps runtime validation disabled by default. Its primary job is fast, complete catalog discovery.

## Verified baseline

A verified full-catalog run over the 110 current targets produced:

```text
Targets: 110
Catalog complete: 110
Catalog requires review: 0
Declared special modes: 126
```

At that point, 71 of the 126 special modes also had runtime proof in the exhaustive artifact. Subsequent code added additional replay fallback and runtime hardening; therefore current code can produce stronger transport coverage than that baseline, but the checked documentation does not claim a higher count until a complete merged artifact proves it.

The catalog-completeness figure and the runtime-proof figure are intentionally separate.

## Generated artifacts

Normal analysis writes under:

```text
artifacts/analysis/
```

Key files:

```text
analysis-report.json
analysis-report.md
bet-catalog.json
bet-catalog.csv
protocol-blueprints.json
unfinished-targets.txt
review-targets.txt
retry-targets.txt
visual-evidence/
```

Exhaustive validation writes a merged artifact named:

```text
3oaks-exhaustive-final
```

## Source-of-truth rules

1. Provider declarations are the source of truth for catalog completeness.
2. A failed automation path cannot remove a declared mode.
3. A screenshot alone is not proof of request semantics.
4. An internal hook alone is not proof of request semantics.
5. A real click + captured request + response is the strongest validation.
6. Replay proof must remain labeled as replay proof.
7. No target may silently disappear from merged output.
8. Unknown or structurally inconsistent protocol data must be preserved for review.

## Important files

```text
analysis/targets.txt
analysis/visual-profiles.json
analysis/visual-plan.json

src/providers/three-oaks.js
src/providers/three-oaks-runtime.js
src/visual-profiles.js
src/browser-service.js
src/network-recorder.js

scripts/analyze-targets.js
scripts/merge-exhaustive-results.js
scripts/run-visual-plan.js

.github/workflows/analyze-targets.yml
.github/workflows/exhaustive-3oaks.yml
.github/workflows/visual-plan.yml
```

Diagnostic scripts under `scripts/` document experiments and family-specific investigation. They are not part of the normal execution path unless explicitly invoked.
