import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const target = {
  id: 'coinup_volcano',
  url: 'https://3oaks.com/api/v1/games/coinup_volcano/play?lang=en',
};
const service = new BrowserService(config);

function parseJson(s) { try { return JSON.parse(s); } catch { return null; } }

function extractStart(events) {
  const req = events.find((e) => e.type === 'request' && (e.url || '').includes('gsc=start'));
  const bodyEvent = events.find((e) => e.type === 'responsebody' && (e.url || '').includes('gsc=start'));
  return { req, body: bodyEvent?.body ? parseJson(bodyEvent.body) : null };
}

function summarizeResponse(events, requestId) {
  const response = events.find((e) => e.type === 'response' && e.requestId === requestId);
  const bodyEvent = events.find((e) => e.type === 'responsebody' && e.requestId === requestId);
  const body = bodyEvent?.body ? parseJson(bodyEvent.body) : null;
  return {
    status: response?.status ?? null,
    command: body?.command ?? null,
    server_status: body?.status ?? null,
    last_action: body?.context?.last_action ?? null,
    last_args: body?.context?.last_args ?? null,
    next_actions: body?.context?.actions ?? null,
    round_finished: body?.context?.round_finished ?? null,
    balance: body?.user?.balance ?? null,
    currency: body?.user?.currency ?? null,
  };
}

async function validateBuy(mode) {
  const session = await service.createSession({
    url: target.url,
    skipSplash: false,
    captureInitialScreenshot: false,
  });
  const internal = service.sessions.get(session.id);
  try {
    const { req: startReq, body: start } = extractStart(internal.recorder.eventsAfter(0));
    if (!startReq || !start) throw new Error('start not found');

    const playUrl = startReq.url.replace('gsc=start', 'gsc=play');
    const params = {
      bet_per_line: start.context?.spins?.bet_per_line,
      lines: start.context?.spins?.lines,
      selected_mode: mode,
    };
    const payload = {
      command: 'play',
      request_id: crypto.randomUUID().replaceAll('-', ''),
      session_id: start.session_id,
      action: { name: 'buy_spin', params },
      set_denominator: 1,
      quick_spin: 1,
      sound: true,
      autogame: false,
      mobile: '0',
      portrait: false,
      fullscreen: true,
      viewportSize: '1280x720',
      client_command_timestamp: Date.now(),
    };

    const marker = internal.recorder.marker();
    const fetchResult = await internal.page.evaluate(async ({ playUrl, payload }) => {
      const response = await fetch(playUrl, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      return { status: response.status };
    }, { playUrl, payload });

    await internal.recorder.waitForActivityAfter(marker, { timeoutMs: 1000 });
    await internal.recorder.waitForQuiet({ quietMs: 300, timeoutMs: 5000 });
    const events = internal.recorder.eventsAfter(marker);
    const request = events.find((e) =>
      e.type === 'request' && e.method === 'POST' && (e.url || '').includes('gsc=play')
    );
    const response = request ? summarizeResponse(events, request.requestId) : null;

    return {
      mode,
      declared_price_multiplier: start.settings?.buy_bonus_prices?.[String(mode)] ?? null,
      request: request?.postData ? parseJson(request.postData) : null,
      fetchStatus: fetchResult.status,
      response,
      startBalance: start.user?.balance ?? null,
      denominator: start.settings?.currency_format?.denominator ?? null,
    };
  } finally {
    await service.closeSession(session.id);
  }
}

await service.start();
try {
  const results = await Promise.all([1, 2, 3].map(validateBuy));
  const report = { generatedAt: new Date().toISOString(), target, results };
  await fs.mkdir(config.artifactDir, { recursive: true });
  await fs.writeFile(path.join(config.artifactDir, 'probe-results.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('REPORT', JSON.stringify(report, null, 2));
} finally {
  await service.stop();
}
