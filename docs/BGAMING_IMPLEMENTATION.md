# BGaming implementation record

## Scope

This document records the BGaming provider work performed in Play-Ci for the current 215-game target list.

The objective is the same as for 3 Oaks: build a complete wager catalog without equating browser automation failure with absence of a wager option.

For each BGaming target, Play-Ci attempts to determine:

- every normal/selectable stake;
- legacy line-bet combinations;
- feature-buy modes and their multipliers;
- chance/ante/booster modes and their multipliers;
- JSON-RPC purchased-feature configurations;
- wire/request fields needed to execute special modes;
- whether the public demo itself is unavailable.

## Verified catalog baseline

A full 215-target analysis produced:

```text
Targets: 215
Provider identified as BGaming: 215
Discovered/catalogable: 212
Public demo unavailable: 3
Requires structural review: 0

Client generations:
- bgaming-v2: 168
- bgaming-jsonrpc: 29
- bgaming-legacy: 14
- bgaming-legacy-fixed-lines: 1
- bgaming-unavailable: 3

Declared buy modes: 319
Declared booster/chance modes: 116
Execution blueprints: 650
```

The three unavailable public demos are:

```text
PrincessOfSky
PrincessRoyal
ScrollOfAdventure
```

BGaming's official public game pages still list these games and expose their historical demo URLs, but those exact demo endpoints currently return the BGaming `Page Not Found` page. They remain marked `UNAVAILABLE_DEMO` rather than guessed.

## Provider generations

The parser currently recognizes four usable BGaming generations.

### 1. v2 bootstrap

Typical bootstrap response contains:

```text
api_version
options
balance
flow
```

Common wager fields include:

```text
options.available_bets
options.default_bet
options.currency
options.feature_options
options.feature_options.feature_multipliers
options.feature_options.disabled_features
```

Some games also expose state maps such as:

```text
bet_to_batch_state
bet_to_multiplier_batch_state
bet_to_recipe_batch_state
bet_to_screen
bet_to_progress_bars
```

The main endpoint pattern is commonly:

```text
https://demo.bgaming-network.com/api/<Game>/<numeric-id>/<session-id>
```

### 2. legacy bootstrap

Older clients commonly expose:

```text
options.line_bets
options.lines
options.buy_feature_value
```

Normal displayed stake is reconstructed from line bet, number of active lines and currency subunits.

The legacy family was validated with real browser clicks on BookOfCats. Normal spin and the buy-feature UI produced the expected provider traffic.

### 3. legacy fixed-line launcher

`AllLuckyClover` is a launcher for multiple concrete line-count games.

The catalog stores separate variants for:

```text
5 lines
20 lines
40 lines
100 lines
```

Each variant has its own raw/display bet list and concrete endpoint game.

### 4. JSON-RPC

Newer/different BGaming clients use JSON-RPC 2.0.

The init request is identified by:

```json
{
  "jsonrpc": "2.0",
  "method": "init"
}
```

Important returned config includes:

```text
result.config.bet_limits
result.config.default_bet
result.config.purchased_features
result.currency_attributes
result.state_lock
```

Normal spin wire shape is represented as:

```json
{
  "jsonrpc": "2.0",
  "method": "play",
  "params": {
    "token": "<SESSION_TOKEN>",
    "req": {
      "bet": "<BET_SUBUNITS>",
      "bet_type": "bet"
    }
  }
}
```

## Critical JSON-RPC rule

`config.purchased_features` is an engine capability list, not a proof that the current game exposes every listed purchase.

For that reason Play-Ci does **not** blindly promote these values into buy modes.

Game-specific special modes are instead extracted from loaded client assets/configuration by:

```text
src/providers/bgaming-jsonrpc-static.js
```

This prevents a major false-positive class.

## JSON-RPC static mode extraction

The current static analyzer recognizes several recurring BGaming client patterns.

Examples include:

- shop definitions with `purchaseFeature`, mode IDs and prices;
- `purchaseFeaturesConfig` structures;
- `feature_id` mappings;
- `machineId` profiles;
- JSON `buyFeatureInfo.configs`;
- engine definitions with normal/super buy costs;
- `bonus_multiplier_type` request variants;
- Yommi-style feature multiplier maps;
- fixed free-spin multipliers;
- plain-spin-only game configurations;
- explicit configurations where feature buy is disabled.

Each extracted mode records:

```text
kind
feature
id / level
multiplier
request_fields
wire_complete
source
evidence_url
```

If the price is known but additional runtime context is still needed to construct the exact wire request, `wire_complete=false` is retained explicitly.

## Special-mode classification

Names are normalized into three broad economic categories.

### buy

Feature purchase / direct bonus purchase.

Typical feature names:

```text
buy_bonus
buy_super_bonus
buy_ultra_bonus
bonus_buy
freespin_buy
```

### booster

An optional stake-enhancing/chance mode rather than a direct bonus purchase.

Typical names:

```text
buy_chance
bonus_chance
freespin_chance
```

### feature

Economic or state-changing provider mode that is not safely classifiable as buy/booster.

Unknown modes are not silently discarded.

## Normal bets

### v2 / JSON-RPC

When the provider exposes total bet subunits:

```text
display_bet = raw_bet / currency.subunits
```

### legacy line bets

When the provider exposes per-line bet subunits:

```text
display_bet = line_bet * active_line_count / currency.subunits
```

All deduplicated display values are preserved in sorted order.

## Execution blueprints

`src/providers/bgaming.js` creates reusable execution blueprints.

Blueprints deliberately retain provider generation because BGaming does not have one universal play shape.

For example:

### v2

```json
{
  "command": "spin",
  "options": {
    "bet": "<BET>"
  }
}
```

Special modes extend `options` with the provider-declared feature fields.

### legacy

Legacy requests can require:

```text
options.bets
options.buy_feature
extra_data.round_series_id
```

### JSON-RPC

JSON-RPC requests can require fields such as:

```text
purchased_feature
feature_id
buy_feature_id
custom_field
bonus_multiplier_type
machineId
bet_type
modelRev
minExponent
custom_req.*
```

The exact fields come from game-specific client evidence. They are not guessed globally.

## Discovery logic

Provider discovery is integrated in:

```text
scripts/analyze-targets.js
```

The discovery order is roughly:

1. look for a known 3 Oaks start;
2. for BGaming targets, wait for a BGaming bootstrap/init;
3. recognize v2/legacy bootstrap;
4. recognize JSON-RPC init;
5. inspect client assets for game-specific JSON-RPC economic modes;
6. identify known special launcher structures;
7. distinguish public-demo unavailability from parser failure;
8. retain unresolved structure as review rather than fabricate a catalog.

BGaming bootstrap misses are retried in bounded sequential retries.

## Response-body limits

Some JSON-RPC game-specific definitions live in large JS/JSON bundles.

The analyzer raises the analysis-session limits to retain enough evidence:

```text
maxBodyBytes >= 12 MiB
maxMemoryEvents >= 30000
```

This is analysis-specific and does not change the basic browser-probe contract.

## UI/network evidence

BGaming investigation used both protocol and visual/runtime evidence.

Representative tools/scripts include:

```text
scripts/capture-bgaming-legacy-ui.js
scripts/validate-bgaming-legacy-clicks.js
scripts/capture-bgaming-jsonrpc-ui.js
scripts/inspect-bgaming-jsonrpc-config.js
scripts/inspect-bgaming-unknowns.js
scripts/probe-bgaming-legacy.js
scripts/probe-bgaming-main-runtime.js
```

The key principle is unchanged:

```text
protocol/static config says what should exist
+
visible/client interaction says how it is reached
+
captured request says what actually went over the wire
```

A failed UI automation path does not delete a catalog declaration.

## Public-demo unavailability

Do not classify a provider `Page Not Found` as a parser failure.

For the current three unavailable games, BGaming's official game pages still identify the products, but their own embedded `data-iframe-src` values point to the same historical URLs that currently return `Page Not Found`.

Therefore the correct status is:

```text
UNAVAILABLE_DEMO
```

not `REQUIRES_REVIEW` and not an invented bet catalog.

## Artifacts

Normal analysis produces the same provider-neutral artifacts:

```text
analysis-report.json
analysis-report.md
bet-catalog.json
bet-catalog.csv
protocol-blueprints.json
unfinished-targets.txt
review-targets.txt
unavailable-targets.txt
retry-targets.txt
```

BGaming catalog rows additionally include fields such as:

```text
bet_encoding
default_bet_raw
default_bet_display
line_count
special_modes
other_features
bootstrap_maps
purchased_feature_capabilities
line_variants
```

## Definition of done for BGaming cataloging

A target is catalog-complete when:

- its normal bet list is known;
- every game-specific buy/chance mode supported by available provider/client evidence is represented;
- every represented special mode has a numeric multiplier/price;
- no generic capability list is misrepresented as a game-specific purchase;
- unresolved wire requirements remain explicitly tagged;
- no failed automation attempt deletes a provider/client declaration.

A target whose official public demo is broken is isolated as `UNAVAILABLE_DEMO`.

## Important files

```text
src/providers/bgaming.js
src/providers/bgaming-jsonrpc-static.js
test/bgaming.test.js
test/bgaming-jsonrpc-static.test.js

scripts/analyze-targets.js
scripts/capture-bgaming-jsonrpc-ui.js
scripts/capture-bgaming-legacy-ui.js
scripts/validate-bgaming-legacy-clicks.js
scripts/inspect-bgaming-jsonrpc-config.js
scripts/inspect-bgaming-unknowns.js

analysis/targets.txt
analysis/capture-trigger.txt
```
