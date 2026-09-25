# Play-Ci architecture

## Purpose

Play-Ci is a provider-agnostic visual + network diagnostics engine for browser casino games.

Its job is not to emulate a game and it is not the final production tester. Its job is to determine, with reproducible evidence, what a real game client exposes and what network request each visible user action actually produces.

The primary loop is:

```text
URL
  ↓
Playwright opens the real client
  ↓
fixed DPR=1 screenshot
  ↓
visual debugger / GPT identifies a visible control and viewport coordinates
  ↓
Playwright performs the real click at those coordinates
  ↓
NetworkRecorder captures requests + responses caused by that click
  ↓
new screenshot
  ↓
repeat until every declared/visible option has been reconciled
```

Protocol inspection is an accelerator and completeness oracle. It is not a substitute for a real UI action when a feature is marked runtime-validated.

## Evidence hierarchy

Evidence is intentionally separated into layers.

### 1. DECLARED

Server/bootstrap protocol says a capability exists.

Examples for 3 Oaks:

- `context.actions`
- `context.available_buy_bonus`
- `context.available_booster`
- `settings.bets`
- `settings.bet_factor`
- `settings.lines`
- `settings.buy_bonus_prices`
- `settings.booster_prices`

A declared feature must never disappear from the catalog merely because our visual/runtime tooling cannot execute it.

### 2. VISUALLY_MAPPED

A screenshot was inspected and a visible control/option was associated with viewport coordinates and a human-readable role.

Example:

```text
BONUS button → (1195, 233)
first visible purchase card → (…)
```

This layer says what the user actually sees.

### 3. VALIDATED

Playwright clicked the visible UI and the resulting browser request was captured and matched to the declared feature.

A runtime validation requires:

1. a real browser session;
2. a visible UI interaction or an already visually validated layout rule;
3. a causally captured request after the click;
4. the expected request semantics;
5. an accepted/recognized server response.

For a buy, this normally means a real `gsc=play` with `action.name = buy_spin`.
For a booster, it normally means a real spin containing the expected `ante_bet` and mode.

### 4. REQUIRES_REVIEW

Used when declaration and visible/runtime behavior cannot yet be reconciled.

Do not silently guess.

## Coordinate invariant

Browser contexts use:

```text
viewport = 1280×720 (default)
deviceScaleFactor = 1
fullPage screenshots = false
```

Therefore:

```text
PNG pixel (x,y)
    ==
viewport CSS pixel (x,y)
    ==
page.mouse.click(x,y)
```

This is the central contract between GPT vision and Playwright.

## State machine

A visual diagnosis should conceptually follow:

```text
OPEN
  ↓
BOOTSTRAP_SCREEN
  ↓
GAME_READY
  ↓
PROTOCOL_DECLARATIONS
  ↓
SCREENSHOT
  ↓
VISUAL_PLAN
  ↓
CLICK
  ↓
NETWORK_SLICE
  ↓
RECONCILE
  ├── more options → SCREENSHOT
  ├── all reconciled → COMPLETE
  └── ambiguity → REQUIRES_REVIEW
```

A click must be associated with a network marker immediately before the action. Only events after that marker belong to that action.

## Protocol discovery vs runtime validation

Protocol discovery is cheap and should happen first.

It answers questions such as:

- how many bet values exist?
- how many buy modes are declared?
- how many boosters exist?
- what multipliers/prices are declared?
- are there additional actions such as `set_params`?

The screenshot loop then proves how those capabilities map to real controls.

The protocol acts as a completion checklist:

```text
start says 2 buys + 3 boosters
            ↓
visual loop must account for 2 buys + 3 boosters
            ↓
captured requests must reconcile all 5 declarations
```

## Repeated layouts

We do not need GPT to manually rediscover identical layouts on every game.

The scalable method is:

1. visually inspect a representative layout;
2. save its UI profile / coordinate rule;
3. apply that real-coordinate click path to games sharing the layout;
4. verify every target independently by its captured request/response;
5. invalidate the profile if the screenshot or resulting request disagrees.

A profile is an execution aid, never proof by itself.

## Network capture

`NetworkRecorder` records:

- request
- response metadata
- textual response body
- requestfinished / requestfailed

Requests and responses share a generated `requestId`.

Sensitive headers are redacted by default.

## Rate limiting

Large validation runs previously produced mass HTTP 403 responses because hundreds of sessions/actions were executed from one GitHub runner/IP.

Current protections include:

- discovery/runtime separation;
- low runtime concurrency;
- sharding;
- batch delays;
- provider 403/429 circuit breaker;
- retry target output;
- avoiding redundant runtime checks.

Exhaustive mode should distribute targets across multiple runners and must stop generating traffic if a provider starts blocking.

## Do not use as final proof

The following are diagnostics only and must not by themselves mark a feature VALIDATED:

- calling a guessed raw API request;
- `APIRequestContext` replay;
- a `TestActions` function existing;
- an internal hook returning successfully;
- a protocol field by itself;
- a screenshot by itself.

The strongest proof is:

```text
visible control
→ real Playwright click
→ captured browser request
→ correlated server response
```

## Current 3 Oaks provider knowledge

The 3 Oaks bootstrap/start protocol is particularly informative. It currently allows us to derive:

- raw bet values;
- bet factors;
- line configurations;
- effective/display bet catalog;
- buy modes;
- fixed-price buys;
- buy multipliers;
- booster modes;
- booster multipliers / `ante_bet`;
- available action names;
- client family.

Observed client families include:

- `goreel`
- `kendoo`
- `ratpack`
- `hraymo`
- `enjoy`

These families do not expose a uniform `TestActions` API. This is why internal hooks must not replace visual interaction.

## Output expectations

For every game the final catalog should contain at minimum:

- URL / game slug;
- provider;
- client family;
- raw bets;
- bet factors;
- line configurations;
- effective/display bets;
- all declared buy modes and multipliers;
- all declared boosters and multipliers;
- review reasons;
- visual/runtime validation status per special mode;
- captured request for validated modes.

No game is considered fully finished if structural declarations remain unexplained.
