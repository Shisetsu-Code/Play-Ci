# PROJECT HANDOFF — read this first in a new chat

## Repository and branch

Repository:

`Shisetsu-Code/Play-Ci`

Current development branch:

`feat/playwright-visual-probe`

Open pull request:

`#1 -> main`

Do not merge unless the user explicitly asks.

## Objective

The user supplies a text file of game URLs. Play-Ci must autonomously build a complete, auditable catalog of every wagering option for every game:

- normal selectable bets;
- line/factor stake variants;
- feature buys;
- fixed and legacy buys;
- boosters / ante bets;
- other economically meaningful provider actions.

A runtime failure must never silently erase a provider-declared option.

## Current user workflow

Input:

`analysis/targets.txt`

Windows launcher:

`run-analysis-gui.bat`

The GUI:

1. selects a local targets file;
2. validates URLs;
3. copies it to `analysis/targets.txt`;
4. increments `analysis/trigger.txt`;
5. commits only the analysis input/trigger files;
6. pushes the current branch;
7. opens GitHub Actions.

When the user says **"analiza"**, inspect the current target list and the latest `Analyze targets` artifact. Do not ask them to paste the URLs again.

## Current 3 Oaks state

The current target list contains 110 3 Oaks games.

Verified catalog-complete baseline:

```text
Targets: 110
Catalog complete: 110
Catalog requires review: 0
Declared special modes: 126
```

A verified exhaustive run at that baseline had runtime proof for 71 special modes. Since then, runtime code has been hardened further with:

- family-aware native invocation;
- visual profiles;
- hybrid native/visual validation;
- fresh-session protocol replay fallback;
- recognition of accepted semantic requests that cannot complete in the demo environment;
- longer capability initialization for slower clients;
- provider block circuit-breaker handling.

Do not claim a newer runtime-validated count until a full merged exhaustive artifact proves it.

## Current architecture

```text
targets.txt
  -> Playwright loads real game
  -> capture 3 Oaks start
  -> protocol parser builds complete catalog
  -> optional runtime proof
       -> visual click
       -> native client method
       -> fresh-session replay fallback
  -> per-mode status
  -> normal/exhaustive artifacts
```

For catalog completeness, `start` is authoritative.

For UI proof, a real visible click remains strongest.

## Important 3 Oaks protocol fields

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

The provider commonly sends JSON with `Content-Type: text/plain`.

## Buy normalization

Supported forms:

1. modern declared modes via `available_buy_bonus + buy_bonus_prices`;
2. legacy zero-based modes via `settings.buy_bonus_price[]`;
3. fixed buy via `settings.freespins_buying_price`;
4. orphan buy-looking metadata is preserved but not promoted when `buy_spin` is absent.

## Normal bet formula

```text
display_bet = raw_bet * bet_factor / denominator
```

Multiple factors/line modes are retained separately and also merged into a deduplicated display-bet list.

## Client families observed

```text
goreel
kendoo
ratpack
hraymo
enjoy
```

Do not treat `TestActions` as a universal API. Different families contain different methods, stubs and mode conventions.

## Kendoo caveat

Kendoo can expose runtime objects while GitHub-hosted Chromium remains visually stuck in a loading state. This was reproduced across headless, SwiftShader, software and headed/Xvfb experiments.

Do not interpret that renderer failure as absence of a declared buy.

Use catalog declarations and lower proof tiers when visual proof is not possible in the runner.

## Visual profiles

File:

`analysis/visual-profiles.json`

Currently mapped representative profiles include:

- Goreel buy-2;
- Enjoy buy-2;
- Hraymo buy-2;
- Ratpack buy-2 + booster-3.

Profiles are keyed by client family and option counts. They are execution aids, not proof by themselves.

## Runtime proof statuses

Strongest to weaker:

```text
VALIDATED_VISUAL
VALIDATED_NATIVE
VALIDATED_PROTOCOL_REPLAY
VALIDATED_REQUEST_RECOGNIZED
VALIDATED_REPLAY_RECOGNIZED
```

Pending/deferred statuses remain visible and do not alter declarations.

See `docs/VALIDATION_POLICY.md` for precise definitions.

## Rate-limit history

A naive full run attempted roughly 230 runtime actions from a single GitHub runner and triggered mass 403 responses.

The fix was:

- discovery/runtime separation;
- sharding;
- low concurrency;
- batch delays;
- circuit breaker after repeated 403/429;
- preserving declarations;
- retry/deferred artifacts.

Never restore high-concurrency exhaustive execution from one runner.

## Normal workflow

Workflow:

`.github/workflows/analyze-targets.yml`

Trigger:

`analysis/trigger.txt`

Runtime validation is disabled by default.

Outputs include:

```text
analysis-report.json
analysis-report.md
bet-catalog.json
bet-catalog.csv
protocol-blueprints.json
unfinished-targets.txt
review-targets.txt
retry-targets.txt
```

## Exhaustive workflow

Workflow:

`.github/workflows/exhaustive-3oaks.yml`

Trigger:

`analysis/exhaustive-trigger.txt`

Current design:

- 12 shards;
- every target independent;
- every special mode enabled;
- `ANALYSIS_RUNTIME_MODE=hybrid`;
- low per-shard concurrency;
- merge step always preserves all target results.

Merged artifact:

`3oaks-exhaustive-final`

## Core files

```text
src/browser-service.js
src/network-recorder.js
src/providers/three-oaks.js
src/providers/three-oaks-runtime.js
src/visual-profiles.js

scripts/analyze-targets.js
scripts/merge-exhaustive-results.js
scripts/run-visual-plan.js

analysis/targets.txt
analysis/visual-profiles.json
analysis/visual-plan.json

.github/workflows/analyze-targets.yml
.github/workflows/exhaustive-3oaks.yml
.github/workflows/visual-plan.yml

tools/analysis_gui.py
```

Diagnostic scripts under `scripts/` preserve investigation history but are not part of the default execution path.

## Read order in a new chat

1. this file;
2. `docs/ARCHITECTURE.md`;
3. `docs/VALIDATION_POLICY.md`;
4. `docs/3OAKS_IMPLEMENTATION.md`;
5. `docs/OPERATIONS.md`;
6. inspect the current PR head;
7. inspect the latest Actions artifacts.

Do not restart the provider investigation from scratch.

## Definition of done

Catalog done:

- all targets present;
- normal bets complete;
- all declared buys present;
- all boosters present;
- structurally unexplained actions isolated;
- no target silently dropped.

Runtime done is stricter and requires a proof status for every special mode. Keep catalog completeness and runtime completeness separate in all reports.
