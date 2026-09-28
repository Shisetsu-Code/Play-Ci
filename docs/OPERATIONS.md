# Operator guide

## Normal user workflow

The ordinary workflow does not require editing JavaScript or using GitHub CLI.

1. Put one game URL per line in a local text file.
2. Open the Play-Ci Windows launcher.
3. Select the text file.
4. Click **Ejecutar en GitHub Actions**.
5. The launcher updates `analysis/targets.txt`, increments `analysis/trigger.txt`, commits only those files and pushes the current branch.
6. GitHub Actions runs `Analyze targets`.
7. Read/download the `play-ci-analysis` artifact.

Launch the GUI with:

```powershell
.\run-analysis-gui.bat
```

or:

```powershell
py -3 tools\analysis_gui.py
```

The GUI uses existing Git authentication. It does not require a manually configured GitHub token.

## targets.txt format

File:

```text
analysis/targets.txt
```

Rules:

- one absolute HTTP(S) URL per line;
- blank lines are ignored;
- lines beginning with `#` are ignored;
- duplicate URLs are removed while preserving order;
- up to 1000 URLs are accepted by the parser.

Example:

```text
# 3 Oaks
https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en
https://3oaks.com/api/v1/games/coinup_volcano/play?lang=en
```

## Normal analysis

Local command:

```powershell
npm run analyze:targets
```

GitHub workflow:

```text
.github/workflows/analyze-targets.yml
```

Trigger file:

```text
analysis/trigger.txt
```

The normal workflow is discovery-first. Runtime validation is disabled by default to avoid unnecessary provider traffic.

Expected output:

```text
artifacts/analysis/analysis-report.json
artifacts/analysis/analysis-report.md
artifacts/analysis/bet-catalog.json
artifacts/analysis/bet-catalog.csv
artifacts/analysis/protocol-blueprints.json
artifacts/analysis/unfinished-targets.txt
artifacts/analysis/review-targets.txt
artifacts/analysis/retry-targets.txt
```

## Exhaustive validation

Use exhaustive validation when every declared special mode must receive a runtime attempt.

Workflow:

```text
.github/workflows/exhaustive-3oaks.yml
```

Trigger file:

```text
analysis/exhaustive-trigger.txt
```

The workflow:

- creates 12 shards;
- processes each target independently;
- enables all buy/booster modes;
- uses hybrid validation;
- merges every shard even if one shard has incomplete runtime proof;
- uploads `3oaks-exhaustive-final`.

The merge artifact contains:

```text
exhaustive-report.json
bet-catalog.json
bet-catalog.csv
summary.md
unfinished-targets.txt
```

## Visual plan workflow

For a layout that needs explicit UI mapping, edit:

```text
analysis/visual-plan.json
```

Trigger:

```text
analysis/visual-trigger.txt
```

Workflow:

```text
.github/workflows/visual-plan.yml
```

Local runner:

```powershell
npm run visual:plan
```

A visual plan can contain:

- waits;
- exact viewport clicks;
- captures.

Each click produces a network slice so the clicked control can be reconciled with the request it caused.

## How to interpret the catalog

### catalog_status = COMPLETE

The provider protocol was understood well enough to enumerate the game's wager choices.

This does not necessarily mean every special mode has visible-click proof.

### runtime_validation_status = COMPLETE

Every declared special mode in that game has an accepted/recognized runtime proof status.

### runtime_validation_status = PARTIAL

The catalog is known, but one or more special modes still lack runtime proof.

### NOT_REQUIRED

The game has no special buy/booster mode requiring runtime validation.

## Statuses to care about

Strong proof:

```text
VALIDATED_VISUAL
VALIDATED_NATIVE
VALIDATED_PROTOCOL_REPLAY
VALIDATED_REQUEST_RECOGNIZED
VALIDATED_REPLAY_RECOGNIZED
```

Pending/diagnostic:

```text
DECLARED_CLIENT_NOT_READY
DECLARED_NATIVE_HOOK_UNAVAILABLE
DECLARED_NATIVE_NO_REQUEST
VISUAL_PROFILE_MISSING
VISUAL_PROFILE_INCOMPLETE
VISUAL_NO_REQUEST
PROTOCOL_REPLAY_START_MISSING
PROTOCOL_REPLAY_REJECTED
DEFERRED_PROVIDER_BLOCK
```

A pending runtime status does not delete the feature from the catalog.

## Provider block behavior

If the provider begins returning 403 or 429:

- the circuit breaker stops further runtime hammering;
- declarations remain intact;
- deferred URLs are written to retry output;
- rerun later in a bounded/sharded job.

Do not increase concurrency to "push through" the block.

## Visual profiles

File:

```text
analysis/visual-profiles.json
```

Profiles are keyed by:

```text
client_family
buy_count
booster_count
```

A profile is reusable only while its clicks continue to produce the expected requests.

If a game with the same nominal profile produces a different layout or request, treat it as a new profile/review case.

## Local development checks

Install:

```powershell
npm install
npx playwright install chromium
```

Static checks:

```powershell
npm run check
```

Tests:

```powershell
npm test
```

`npm test` is intentionally limited to `test/*.test.js`; diagnostic scripts under `scripts/` are not part of the unit test suite.

## Before changing provider logic

Read:

1. `docs/PROJECT_HANDOFF.md`
2. `docs/ARCHITECTURE.md`
3. `docs/VALIDATION_POLICY.md`
4. `docs/3OAKS_IMPLEMENTATION.md`

Then inspect the latest Actions artifact rather than re-running old experiments blindly.
