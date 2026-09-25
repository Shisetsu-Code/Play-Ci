import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const service = new BrowserService(config);
await service.start();
try {
  const session = await service.createSession({
    url: 'https://3oaks.com/api/v1/games/coinup_volcano/play?lang=en',
    skipSplash: false,
    captureInitialScreenshot: false,
  });
  const internal = service.sessions.get(session.id);
  const events = internal.recorder.eventsAfter(0);
  const bodyEvent = events.find((e) => e.type === 'responsebody' && (() => {
    try { return JSON.parse(e.body)?.command === 'start'; } catch { return false; }
  })());
  const req = bodyEvent && events.find((e) => e.type === 'request' && e.requestId === bodyEvent.requestId);
  const original = JSON.parse(req.postData);

  async function startFresh(label, freshIds) {
    const payload = {
      ...original,
      request_id: crypto.randomUUID().replaceAll('-', ''),
      client_command_timestamp: Date.now(),
    };
    if (freshIds) {
      payload.session_id = crypto.randomUUID().replaceAll('-', '');
      payload.huid = 'demo-' + crypto.randomUUID().replaceAll('-', '');
    }
    const response = await internal.context.request.post(req.url, {
      headers: { 'content-type': 'text/plain', referer: 'https://3oaks.com/' },
      data: JSON.stringify(payload),
      failOnStatusCode: false,
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    console.log(label, JSON.stringify({
      http: response.status(),
      request_session_id: payload.session_id,
      request_huid: payload.huid,
      status: body?.status,
      response_session_id: body?.session_id,
      response_huid: body?.user?.huid,
      actions: body?.context?.actions,
      balance: body?.user?.balance,
      raw: body ? undefined : text.slice(0, 300),
    }, null, 2));
    return { payload, body };
  }

  const same = await startFresh('REPLAY_SAME_IDS', false);
  const fresh = await startFresh('REPLAY_FRESH_IDS', true);

  if (fresh.body?.status?.code === 'OK') {
    const playUrl = new URL(req.url);
    playUrl.searchParams.set('gsc', 'play');
    const start = fresh.body;
    const playPayload = {
      command: 'play',
      request_id: crypto.randomUUID().replaceAll('-', ''),
      session_id: start.session_id,
      action: {
        name: 'buy_spin',
        params: {
          bet_per_line: start.context.spins.bet_per_line,
          lines: start.context.spins.lines,
          selected_mode: 1,
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
    const response = await internal.context.request.post(playUrl.toString(), {
      headers: { 'content-type': 'text/plain', referer: 'https://3oaks.com/' },
      data: JSON.stringify(playPayload),
      failOnStatusCode: false,
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    console.log('FRESH_PLAY', JSON.stringify({
      http: response.status(),
      status: body?.status,
      last_action: body?.context?.last_action,
      last_args: body?.context?.last_args,
      next_actions: body?.context?.actions,
      balance: body?.user?.balance,
      raw: body ? undefined : text.slice(0, 300),
    }, null, 2));
  }

  await service.closeSession(session.id);
} finally {
  await service.stop();
}
