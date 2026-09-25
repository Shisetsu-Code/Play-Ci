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
  await sleep(2000);

  const inspect = await internal.page.evaluate(() => {
    const ta = window.TestActions;
    const chain = [];
    let obj = ta;
    for (let depth = 0; obj && depth < 5; depth += 1, obj = Object.getPrototypeOf(obj)) {
      chain.push({
        depth,
        names: Object.getOwnPropertyNames(obj),
      });
    }
    const names = ['playBuyFeature','activateShopOption','spin','playSpin','actSpin','play'];
    const funcs = {};
    for (const name of names) {
      const fn = ta?.[name] || window.app?.board?.[name] || window.app?.board?.buyFeature?.[name];
      if (typeof fn === 'function') {
        funcs[name] = Function.prototype.toString.call(fn).slice(0, 4000);
      }
    }
    return {
      chain,
      funcs,
      appBoardKeys: Object.keys(window.app?.board || {}),
      appBoardProto: window.app?.board ? Object.getOwnPropertyNames(Object.getPrototypeOf(window.app.board)) : [],
    };
  });
  console.log('INSPECT', JSON.stringify(inspect, null, 2));

  await service.closeSession(session.id);
} finally {
  await service.stop();
}
