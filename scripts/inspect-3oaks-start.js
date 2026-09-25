import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const url = 'https://3oaks.com/api/v1/games/coinup_volcano/play?lang=en';
const service = new BrowserService(config);
await service.start();
try {
  const session = await service.createSession({ url, skipSplash: false, captureInitialScreenshot: false });
  const internal = service.sessions.get(session.id);
  const events = internal.recorder.eventsAfter(0);
  const bodyEvent = events.find((e) => e.type === 'responsebody' && (() => {
    try { return JSON.parse(e.body)?.command === 'start'; } catch { return false; }
  })());
  const req = bodyEvent && events.find((e) => e.type === 'request' && e.requestId === bodyEvent.requestId);
  console.log('START_REQUEST', JSON.stringify({
    method: req?.method,
    url: req?.url,
    headers: req?.headers,
    postData: req?.postData,
  }, null, 2));
  console.log('START_RESPONSE', bodyEvent?.body || null);
  await service.closeSession(session.id);
} finally {
  await service.stop();
}
