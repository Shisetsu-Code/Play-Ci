import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const url = 'https://3oaks.com/api/v1/games/coinup_volcano/play?lang=en';
const service = new BrowserService(config);

function parse(s) { try { return JSON.parse(s); } catch { return null; } }

await service.start();
try {
  const session = await service.createSession({ url, skipSplash: false, captureInitialScreenshot: false });
  const internal = service.sessions.get(session.id);
  const events = internal.recorder.eventsAfter(0);
  const bodyEvent = events.find((e) => e.type === 'responsebody' && parse(e.body)?.command === 'start');
  const req = bodyEvent && events.find((e) => e.type === 'request' && e.requestId === bodyEvent.requestId);
  const startBody = parse(bodyEvent?.body || '');

  if (!req || !startBody) throw new Error('initial start not found');
  const originalStartReq = parse(req.postData || '');
  const playUrl = new URL(req.url);
  playUrl.searchParams.set('gsc', 'play');

  async function freshStart() {
    const payload = {
      ...originalStartReq,
      request_id: crypto.randomUUID().replaceAll('-', ''),
      client_command_timestamp: Date.now(),
    };
    const res = await internal.context.request.post(req.url, {
      headers: { 'content-type': 'text/plain', referer: 'https://3oaks.com/' },
      data: JSON.stringify(payload),
      failOnStatusCode: false,
    });
    const text = await res.text();
    return { status: res.status(), body: parse(text), text };
  }

  async function buy(mode, fresh) {
    const payload = {
      command: 'play',
      request_id: crypto.randomUUID().replaceAll('-', ''),
      session_id: fresh.body.session_id,
      action: {
        name: 'buy_spin',
        params: {
          bet_per_line: fresh.body.context.spins.bet_per_line,
          lines: fresh.body.context.spins.lines,
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
    const body = parse(text);
    return {
      mode,
      http: res.status(),
      status: body?.status,
      last_action: body?.context?.last_action,
      last_args: body?.context?.last_args,
      balance: body?.user?.balance,
      actions: body?.context?.actions,
    };
  }

  const results = [];
  for (const mode of [1,2,3]) {
    const fresh = await freshStart();
    results.push({
      fresh: {
        http: fresh.status,
        status: fresh.body?.status,
        balance: fresh.body?.user?.balance,
        actions: fresh.body?.context?.actions,
      },
      buy: await buy(mode, fresh),
    });
  }

  console.log('LOGICAL_RESET_RESULTS', JSON.stringify(results, null, 2));
  await service.closeSession(session.id);
} finally {
  await service.stop();
}
