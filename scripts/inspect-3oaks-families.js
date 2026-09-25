import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractThreeOaksStart, summarizeThreeOaksStart } from '../src/providers/three-oaks.js';

const targets = [
  { family: 'hraymo', url: 'https://3oaks.com/api/v1/games/3_african_drums/play?lang=en' },
  { family: 'goreel', url: 'https://3oaks.com/api/v1/games/3_aztec_temples/play?lang=en' },
  { family: 'ratpack', url: 'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en' },
  { family: 'kendoo', url: 'https://3oaks.com/api/v1/games/3_coin_volcanoes/play?lang=en' },
  { family: 'enjoy', url: 'https://3oaks.com/api/v1/games/3_superpower_diamonds/play?lang=en' },
];

const service = new BrowserService(config);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parse(text) { try { return JSON.parse(text); } catch { return null; } }

function rawStartRequest(events, start) {
  if (!start?.request) return null;
  return events.find((event) =>
    event.type === 'request' &&
    event.url === start.request.url &&
    event.method === start.request.method
  ) || null;
}

async function validateInOriginFrame(target) {
  const session = await service.createSession({
    url: target.url,
    skipSplash: false,
    captureInitialScreenshot: false,
  });
  const internal = service.sessions.get(session.id);

  try {
    const events = internal.recorder.eventsAfter(0);
    const start = extractThreeOaksStart(events);
    if (!start?.body || !start?.request?.url) {
      return { ...target, error: 'start_missing' };
    }

    const protocol = summarizeThreeOaksStart(start);
    const mode = protocol.available_buy_bonus?.[0];
    const reqEvent = rawStartRequest(events, start);
    const playUrl = new URL(start.request.url);
    playUrl.searchParams.set('gsc', 'play');

    const frames = internal.page.frames().map((frame) => frame.url());

    if (mode == null) {
      return { ...target, protocol, frames, start_frame_url: reqEvent?.frameUrl ?? null, validation: { skipped: 'no_buy_mode' } };
    }

    const payload = {
      command: 'play',
      request_id: crypto.randomUUID().replaceAll('-', ''),
      session_id: start.body.session_id,
      action: {
        name: 'buy_spin',
        params: {
          bet_per_line: start.body.context.spins.bet_per_line,
          lines: start.body.context.spins.lines,
          selected_mode: mode,
        },
      },
      set_denominator: 1,
      quick_spin: 1,
      sound: true,
      autogame: false,
      mobile: '0',
      portrait: false,
      fullscreen: true,
      viewportSize: `${config.viewport.width}x${config.viewport.height}`,
      client_command_timestamp: Date.now(),
    };

    const marker = internal.recorder.marker();
    const result = await internal.page.evaluate(async ({ url, payload }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        if (typeof window.__playCiNativeFetch !== 'function') {
          return { ok: false, error: 'native_fetch_missing' };
        }
        const response = await window.__playCiNativeFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          credentials: 'include',
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const text = await response.text();
        return { ok: true, status: response.status, text };
      } catch (error) {
        return {
          ok: false,
          error: error?.name === 'AbortError' ? 'browser_fetch_timeout' : (error?.message || String(error)),
        };
      } finally {
        clearTimeout(timer);
      }
    }, { url: playUrl.toString(), payload });

    await internal.recorder.waitForActivityAfter(marker, { timeoutMs: 1500 });
    await internal.recorder.waitForQuiet({ quietMs: 400, timeoutMs: 5000 });

    const body = result.text ? parse(result.text) : null;
    return {
      ...target,
      protocol,
      frames,
      start_frame_url: reqEvent?.frameUrl ?? null,
      validation: {
        mode,
        declared_multiplier: protocol.buy_bonus_prices?.[String(mode)] ?? null,
        browser_fetch_ok: result.ok,
        fetch_error: result.error ?? null,
        http_status: result.status ?? null,
        server_status: body?.status ?? null,
        last_action: body?.context?.last_action ?? null,
        last_args: body?.context?.last_args ?? null,
        next_actions: body?.context?.actions ?? null,
        round_finished: body?.context?.round_finished ?? null,
        balance: body?.user?.balance ?? null,
        raw: body ? null : result.text?.slice(0, 500) ?? null,
      },
    };
  } finally {
    await service.closeSession(session.id);
  }
}

await service.start();
try {
  const results = [];
  for (const target of targets) {
    results.push(await validateInOriginFrame(target));
    await sleep(800);
  }

  await fs.mkdir('artifacts/family-inspection', { recursive: true });
  await fs.writeFile(
    path.join('artifacts/family-inspection', 'browser-frame-validation.json'),
    JSON.stringify(results, null, 2),
    'utf8'
  );
  console.log('BROWSER_FRAME_VALIDATION', JSON.stringify(results, null, 2));
} finally {
  await service.stop();
}
