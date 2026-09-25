import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractThreeOaksStart } from '../src/providers/three-oaks.js';

const url = 'https://3oaks.com/api/v1/games/coinup_volcano/play?lang=en';
const service = new BrowserService(config);

function parse(text) { try { return JSON.parse(text); } catch { return null; } }

await service.start();
try {
  const session = await service.createSession({ url, skipSplash: false, captureInitialScreenshot: false });
  const internal = service.sessions.get(session.id);
  const start = extractThreeOaksStart(internal.recorder.eventsAfter(0));
  if (!start?.request?.url || !start?.request?.postData) throw new Error('start request missing');

  const originalStartPayload = parse(start.request.postData);
  const playUrl = new URL(start.request.url);
  playUrl.searchParams.set('gsc', 'play');

  async function reset() {
    const payload = {
      ...originalStartPayload,
      request_id: crypto.randomUUID().replaceAll('-', ''),
      client_command_timestamp: Date.now(),
    };
    const res = await internal.context.request.post(start.request.url, {
      headers: { 'content-type': 'text/plain', referer: 'https://3oaks.com/' },
      data: JSON.stringify(payload),
      failOnStatusCode: false,
    });
    const text = await res.text();
    return { status: res.status(), body: parse(text), raw: text.slice(0, 500) };
  }

  async function buy(fresh, mode) {
    const body = fresh.body;
    const payload = {
      command: 'play',
      request_id: crypto.randomUUID().replaceAll('-', ''),
      session_id: body.session_id,
      action: {
        name: 'buy_spin',
        params: {
          bet_per_line: body.context.spins.bet_per_line,
          lines: body.context.spins.lines,
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
      viewportSize: '1280x720',
      client_command_timestamp: Date.now(),
    };
    const res = await internal.context.request.post(playUrl.toString(), {
      headers: { 'content-type': 'text/plain', referer: 'https://3oaks.com/' },
      data: JSON.stringify(payload),
      failOnStatusCode: false,
    });
    const text = await res.text();
    const rb = parse(text);
    return {
      mode,
      http: res.status(),
      server: rb?.status,
      last_action: rb?.context?.last_action,
      last_args: rb?.context?.last_args,
      next_actions: rb?.context?.actions,
      balance: rb?.user?.balance,
      session_id: rb?.session_id,
      raw: rb ? null : text.slice(0, 500),
    };
  }

  const results = [];
  for (const mode of [1,2,3]) {
    const fresh = await reset();
    results.push({
      reset: {
        http: fresh.status,
        server: fresh.body?.status,
        session_id: fresh.body?.session_id,
        balance: fresh.body?.user?.balance,
        actions: fresh.body?.context?.actions,
        round_finished: fresh.body?.context?.round_finished,
        raw: fresh.body ? null : fresh.raw,
      },
      buy: await buy(fresh, mode),
    });
  }

  console.log('RESET_BUY_RESULTS', JSON.stringify(results, null, 2));
  await service.closeSession(session.id);
} finally {
  await service.stop();
}
