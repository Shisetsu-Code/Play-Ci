# PROJECT HANDOFF — read this first in a new chat

## Repository

`Shisetsu-Code/Play-Ci`

Current development line during this handoff:

`feat/playwright-visual-probe`

There is an open PR (#1) into `main`.

Do not merge unless the user explicitly asks.

## What the user wants

The user wants to feed a text file containing game URLs and have ChatGPT/Play-Ci autonomously determine **all wagering options for every game**.

The intended universal mechanism is visual:

```text
Playwright opens game
→ screenshot
→ GPT reads screenshot
→ GPT returns coordinates
→ Playwright clicks actual visible control
→ capture resulting request/response
→ screenshot new state
→ repeat
```

Protocol parsing should make this faster and provide a completeness checklist, but should not replace real visual clicks for runtime proof.

## Why Play-Ci exists

Other project components have different responsibilities:

- Play-Ci: discovery/diagnostics/visual network proof.
- Tester-definitivo / Testers: stable execution of already understood provider protocols.
- Crawler repos: catalog/name/thumbnail discovery.
- Porteo: HAR collection/sanitization/diagnostic evidence.

Do not turn Play-Ci into the final production tester.

## User workflow

The user maintains:

`analysis/targets.txt`

A small Windows GUI is available:

`run-analysis-gui.bat`

It:

1. lets the user select a local targets file;
2. validates it;
3. copies it to `analysis/targets.txt`;
4. increments `analysis/trigger.txt`;
5. commits only those analysis files;
6. pushes the current branch;
7. triggers GitHub Actions.

When the user says **"analiza"**, read the current target list/run artifacts rather than asking them to paste the URLs again.

## What has already been learned

### Core Playwright probe

Implemented:

- fixed 1280×720 viewport;
- DPR=1;
- non-full-page PNG screenshots;
- exact coordinate click API;
- correlated network recorder;
- request/response/body capture;
- conservative DOM splash skipping;
- canvas/WebGL bootstrap support;
- click observation window for delayed requests;
- heavier screenshot timeout for WebGL;
- optional screenshot capture;
- multiple browser contexts.

### 3 Oaks

3 Oaks `start` can expose:

- `context.actions`
- `context.available_buy_bonus`
- `context.available_booster`
- `settings.bets`
- `settings.bet_factor`
- `settings.lines`
- `settings.buy_bonus_prices`
- legacy/fixed buy metadata
- `settings.booster_prices`

Provider play requests commonly use `Content-Type: text/plain`.

Observed buy request pattern:

```json
{
  "command": "play",
  "action": {
    "name": "buy_spin",
    "params": {
      "bet_per_line": "...",
      "lines": "...",
      "selected_mode": "..."
    }
  }
}
```

Observed booster pattern:

```json
{
  "command": "play",
  "action": {
    "name": "spin",
    "params": {
      "bet_per_line": "...",
      "lines": "...",
      "ante_bet": "...",
      "selected_mode": "..."
    }
  }
}
```

Not every game uses every field.

### Early live examples

`4_super_clover_pots`:

- 2 buy modes declared;
- 3 boosters declared;
- buy prices 75× and 200×;
- boosters 1.75×, 3×, 7.5×;
- real browser validation previously confirmed buys and booster behavior.

`coinup_volcano`:

- 3 buys declared;
- 30×, 75×, 150×;
- real server validation previously confirmed all three.

### 110-game run

A target list containing 110 3 Oaks games was analyzed.

Important historical result:

- protocol discovery worked across essentially the entire set;
- a naive runtime phase opened too many sessions and caused mass HTTP 403;
- the architecture was changed to separate discovery from runtime, shard work, lower concurrency and use a circuit breaker;
- client families observed: `goreel`, `kendoo`, `ratpack`, `hraymo`, `enjoy`.

A later adaptive run removed the mass 403 problem but exposed false negatives from non-uniform internal hooks.

### Critical lesson

Do **not** treat `TestActions` as a universal provider API.

Different families have stubs, different signatures and different mode indexing.

A successful internal hook is not validation.
A failed internal hook is not evidence that a declared feature is absent.

### Rate-limit lesson

A previous 110-game validation attempted ~230 runtime actions from one runner and produced mass 403s.

Use:

- shards;
- low concurrency;
- circuit breaker;
- protocol-first discovery;
- minimal runtime actions;
- retry artifacts.

## Current important files

- `src/browser-service.js` — Chromium sessions/screenshots/clicks.
- `src/network-recorder.js` — correlated traffic capture.
- `src/providers/three-oaks.js` — 3 Oaks declaration parsing/catalog logic.
- `src/providers/three-oaks-runtime.js` — diagnostic runtime helpers; do not mistake hooks for proof.
- `scripts/analyze-targets.js` — batch analyzer/report builder.
- `scripts/merge-exhaustive-results.js` — merges sharded exhaustive output.
- `.github/workflows/analyze-targets.yml` — normal discovery run.
- `.github/workflows/exhaustive-3oaks.yml` — sharded exhaustive run.
- `tools/analysis_gui.py` — Windows launcher GUI.
- `analysis/targets.txt` — current input list.

## Current architectural correction

The project briefly drifted toward:

`start → internal hook → request`

That is not the desired final validator.

The desired validator is:

`start → screenshot → GPT coordinates → real click → request`

The `start` response remains authoritative for declared completeness, while the real UI click establishes the visible-to-wire mapping.

## What to do next

1. Finish capturing representative screenshots for each 3 Oaks client family/layout.
2. Have GPT identify:
   - startup dismiss area;
   - bet controls;
   - buy/bonus button;
   - buy popup choices;
   - booster/shop controls;
   - spin control.
3. Store visually verified layout profiles.
4. Apply those coordinate paths to matching games.
5. For every game, compare clicked request against its declaration.
6. Invalidate/review any game whose screenshot/layout or request differs from its profile.
7. Run sharded exhaustive validation.
8. Merge outputs into the final bet catalog.
9. Resolve any remaining `REQUIRES_REVIEW`, especially unknown economic actions.

## Definition of done

Do not call the 3 Oaks phase complete merely because `start` was parsed.

Done means:

- normal bets for every target are cataloged;
- all buy modes are cataloged;
- all boosters/ante bets are cataloged;
- unexplained actions are resolved or explicitly isolated;
- real UI→request mappings are validated for every special mode/layout;
- final merged report contains all target URLs;
- no target silently disappears because a runtime attempt failed.

## Commands / outputs

Normal analysis:

```powershell
npm run analyze:targets
```

Main output directory:

`artifacts/analysis/`

Expected artifacts include:

- `analysis-report.json`
- `analysis-report.md`
- `bet-catalog.json`
- `bet-catalog.csv`
- `protocol-blueprints.json`
- review/retry target lists

The exhaustive workflow produces a merged final artifact.

## Safety against context loss

At the beginning of a future chat:

1. read this file;
2. read `docs/ARCHITECTURE.md`;
3. read `docs/VALIDATION_POLICY.md`;
4. inspect the current PR head and latest Actions artifacts;
5. continue from the remaining incomplete targets, not from scratch.
