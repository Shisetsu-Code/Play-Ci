import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const service = new BrowserService(config);
await service.start();
try {
  const session = await service.createSession({
    url: 'https://3oaks.com/api/v1/games/coinup_volcano/play?lang=en',
    skipSplash: false,
    captureInitialScreenshot: false,
  });
  const internal = service.sessions.get(session.id);

  await internal.page.mouse.click(640, 670);
  await sleep(2500);

  const capabilities = await internal.page.evaluate(() => ({
    testActions: Object.keys(window.TestActions || {}),
    app: Boolean(window.app),
    board: Boolean(window.app?.board),
    buyFeature: Boolean(window.app?.board?.buyFeature),
  }));
  console.log('CAPABILITIES', JSON.stringify(capabilities));

  const marker = internal.recorder.marker();
  const invoked = await internal.page.evaluate(() => {
    if (typeof window.TestActions?.playBuyFeature === 'function') {
      window.TestActions.playBuyFeature(1);
      return 'TestActions.playBuyFeature';
    }
    if (typeof window.app?.board?.buyFeature?.actBuyFeature === 'function') {
      window.app.board.buyFeature.actBuyFeature(1);
      return 'app.board.buyFeature.actBuyFeature';
    }
    return null;
  });
  console.log('INVOKED', invoked);

  await internal.recorder.waitForActivityAfter(marker, { timeoutMs: 2500 });
  await internal.recorder.waitForQuiet({ quietMs: 700, timeoutMs: 10000 });

  const events = internal.recorder.eventsAfter(marker);
  const reqs = events.filter((e) => e.type === 'request' && (e.url || '').includes('gsc=play'));
  for (const req of reqs) {
    const res = events.find((e) => e.type === 'response' && e.requestId === req.requestId);
    const body = events.find((e) => e.type === 'responsebody' && e.requestId === req.requestId);
    console.log('NATIVE_PLAY', JSON.stringify({
      method: req.method,
      url: req.url,
      postData: req.postData,
      http: res?.status,
      responseBody: body?.body?.slice?.(0, 2000) || null,
    }, null, 2));
  }

  await service.closeSession(session.id);
} finally {
  await service.stop();
}
