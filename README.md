# Play-Ci

Play-Ci is a deterministic Playwright visual/network probe for an external debugger.

The intended loop is deliberately simple:

1. Open a supplied game URL in Chromium.
2. Conservatively dismiss a normal DOM startup/splash button such as `PLAY`, `START` or `CONTINUE`.
3. Capture a fixed-size viewport screenshot.
4. An external visual debugger reads that PNG and returns viewport coordinates.
5. Play-Ci clicks the exact `(x, y)` coordinate and returns only the network activity generated after that click, while also appending the complete session trace to `network.jsonl`.
6. Capture the next screenshot and repeat.

## Coordinate invariant

The browser context always uses `deviceScaleFactor: 1` and screenshots use `fullPage: false`.

Therefore:

```text
PNG pixel (x, y) == viewport CSS pixel (x, y) == page.mouse.click(x, y)
```

This remains true when the visible game is rendered in an iframe, canvas or WebGL surface because the click is issued in top-level viewport coordinates.

Default viewport: `1280x720`.

## Install (PowerShell)

```powershell
git clone https://github.com/Shisetsu-Code/Play-Ci.git
cd Play-Ci
npm install
npx playwright install chromium
npm start
```

The API listens on `http://127.0.0.1:31337` by default.

## Open one URL and obtain the first screenshot

```powershell
$body = @{
  url = "https://example.com/game"
  skipSplash = $true
} | ConvertTo-Json

$session = Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:31337/v1/sessions" `
  -ContentType "application/json" `
  -Body $body

$session
```

Important fields:

```json
{
  "id": "...",
  "viewport": { "width": 1280, "height": 720 },
  "deviceScaleFactor": 1,
  "screenshot": {
    "url": "/v1/sessions/.../artifacts/0001-ready.png",
    "coordinateSpace": "viewport-css-px=dpr1-png-px"
  }
}
```

Download the screenshot if the debugger wants a file:

```powershell
Invoke-WebRequest `
  -Uri ("http://127.0.0.1:31337" + $session.screenshot.url) `
  -OutFile ".\ready.png"
```

## Click coordinates returned by the debugger

If the debugger says the target is at `(640, 515)`:

```powershell
$click = @{
  x = 640
  y = 515
} | ConvertTo-Json

$result = Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:31337/v1/sessions/$($session.id)/click" `
  -ContentType "application/json" `
  -Body $click

$result.requests
$result.screenshot
```

`result.requests` contains only outgoing requests generated after the click. `result.responses` contains the corresponding responses and `result.events` contains the complete correlated event slice. Matching request/response entries share the same `requestId`. Textual response bodies are captured up to the configured size limit.

The full session network trace is always retained at:

```text
artifacts/<session-id>/network.jsonl
```

## Capture again without clicking

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:31337/v1/sessions/$($session.id)/screenshot" `
  -ContentType "application/json" `
  -Body '{"label":"analysis"}'
```

## Query network events after a marker

```powershell
Invoke-RestMethod `
  -Uri "http://127.0.0.1:31337/v1/sessions/$($session.id)/network?after=120"
```

## Close a session

```powershell
Invoke-RestMethod `
  -Method Delete `
  -Uri "http://127.0.0.1:31337/v1/sessions/$($session.id)"
```

## Multiple URLs

Create up to 20 live sessions in one request:

```powershell
$body = @{
  urls = @(
    "https://example.com/game-a",
    "https://example.com/game-b"
  )
  skipSplash = $true
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:31337/v1/sessions/batch" `
  -ContentType "application/json" `
  -Body $body
```

For simple screenshot-only batch capture, put one URL per line in `urls.txt` and run:

```powershell
npm run batch -- .\urls.txt
```

## Splash handling

Automatic splash handling is intentionally conservative. It waits up to 8 seconds and performs at most one automatic click on a visible DOM control whose text is an unambiguous startup action such as `PLAY`, `START`, `CONTINUE`, `JUGAR` or `COMENZAR`.

It explicitly refuses gameplay/economic controls containing terms such as `SPIN`, `BET`, `BUY`, `BONUS`, `AUTOPLAY`, `APUESTA`, `COMPRAR` or `GIRAR`.

Canvas/WebGL startup screens cannot be identified safely from DOM text. For those games the caller can provide one or more known bootstrap coordinates:

```json
{
  "url": "https://example.com/game",
  "skipSplash": true,
  "bootstrapClicks": [
    { "x": 640, "y": 360 }
  ]
}
```

Those coordinates are executed before the conservative DOM splash pass. A future visual bootstrap agent can use this same input without changing Play-Ci itself.

## Configuration

Environment variables:

- `PORT=31337`
- `HOST=127.0.0.1`
- `VIEWPORT_WIDTH=1280`
- `VIEWPORT_HEIGHT=720`
- `ARTIFACT_DIR=artifacts`
- `HEADED=1` to see Chromium
- `NAVIGATION_TIMEOUT_MS=45000`
- `INITIAL_SETTLE_MS=1500`
- `SPLASH_TIMEOUT_MS=8000`
- `CLICK_SETTLE_TIMEOUT_MS=3500`
- `CLICK_OBSERVATION_MS=600` — minimum post-click observation window before declaring the network quiet
- `QUIET_WINDOW_MS=500`
- `MAX_RESPONSE_BODY_BYTES=2097152`
- `CAPTURE_SENSITIVE_HEADERS=1` to disable default redaction of cookies/auth headers

## Security / trace hygiene

Authorization, cookies, API keys and similar sensitive headers are redacted in logs by default. POST bodies are captured because they are usually the important protocol evidence, so generated artifacts must still be treated as potentially sensitive.

Play-Ci does not infer bets, buys, bonuses or game semantics. It only performs explicit coordinates supplied by the caller and records what the browser actually sent/received.


## Analysis queue

Edit `analysis/targets.txt` in GitHub and put one absolute HTTP(S) URL per line. Blank lines and lines beginning with `#` are ignored. Duplicate URLs are removed while preserving order.

Editing the target list does **not** launch a browser run. Analysis starts only when `analysis/trigger.txt` changes (or when the workflow is manually dispatched).

The intended ChatGPT workflow is:

1. You edit `analysis/targets.txt`.
2. You tell ChatGPT: **analiza**.
3. ChatGPT reads the current target file, increments `analysis/trigger.txt`, waits for the `Analyze targets` workflow, reads the `play-ci-analysis` artifact and reports the result.
4. Protocol-first analyzers validate known providers automatically. Unknown protocols are marked `REQUIRES_REVIEW` instead of guessing.

For 3 Oaks, the analyzer extracts the server-declared actions, bets, buy modes, buy prices, boosters and booster prices from `start`, then validates base spin / declared modes in fresh sessions using the same Playwright browser context. No screenshots are taken unless a later review explicitly needs vision.

Local execution:

```powershell
npm run analyze:targets
```

Output:

```text
artifacts/analysis/analysis-report.json
artifacts/analysis/analysis-report.md
```


## Windows GUI for target analysis

A small Tkinter launcher is included for Windows. It lets you choose any local `targets.txt` and launch the GitHub Actions analysis without manually running Git commands.

Double-click:

```text
run-analysis-gui.bat
```

Or from PowerShell:

```powershell
py -3 tools\analysis_gui.py
```

The GUI:

1. validates the selected file;
2. copies it to `analysis/targets.txt`;
3. increments `analysis/trigger.txt`;
4. creates a commit containing only those two analysis files;
5. pushes the current branch to `origin`;
6. opens the `Analyze targets` workflow in GitHub Actions.

It does not require GitHub CLI or a manually configured API token. It uses the repository's existing Git authentication.


The target list accepts up to **1000 URLs** per run. Execution concurrency remains limited, so a large file is processed in controlled parallel batches rather than opening 1000 Chromium contexts at once.
