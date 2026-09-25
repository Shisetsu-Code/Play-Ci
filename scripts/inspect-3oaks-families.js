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

async function inspectAndValidate(target) {
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
    if (mode == null) {
      return { ...target, protocol, validation: { skipped: 'no_buy_mode' } };
    }

    const playUrl = new URL(start.request.url);
    playUrl.searchParams.set('gsc', 'play');

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

    const response = await internal.context.request.post(playUrl.toString(), {
      headers: {
        'content-type': 'text/plain',
        referer: 'https://3oaks.com/',
      },
      data: JSON.stringify(payload),
      failOnStatusCode: false,
    });
    const text = await response.text();
    const body = parse(text);

    return {
      ...target,
      protocol,
      validation: {
        mode,
        declared_multiplier: protocol.buy_bonus_prices?.[String(mode)] ?? null,
        http_status: response.status(),
        server_status: body?.status ?? null,
        last_action: body?.context?.last_action ?? null,
        last_args: body?.context?.last_args ?? null,
        next_actions: body?.context?.actions ?? null,
        round_finished: body?.context?.round_finished ?? null,
        balance: body?.user?.balance ?? null,
        raw: body ? null : text.slice(0, 500),
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
    results.push(await inspectAndValidate(target));
    await sleep(800);
  }

  await fs.mkdir('artifacts/family-inspection', { recursive: true });
  await fs.writeFile(
    path.join('artifacts/family-inspection', 'direct-validation.json'),
    JSON.stringify(results, null, 2),
    'utf8'
  );
  console.log('DIRECT_VALIDATION', JSON.stringify(results, null, 2));
} finally {
  await service.stop();
}
