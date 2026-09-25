import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const games = [
  ['coinup_volcano', 'https://3oaks.com/api/v1/games/coinup_volcano/play?lang=en'],
  ['4_super_clover_pots', 'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en'],
];
const service = new BrowserService(config);
await service.start();

async function probe(name, url) {
  const session = await service.createSession({ url, skipSplash: false, captureInitialScreenshot: false });
  const internal = service.sessions.get(session.id);
  try {
    await sleep(1200);
    const inspect = await internal.page.evaluate(() => {
      const ta = window.TestActions;
      const proto = ta ? Object.getPrototypeOf(ta) : null;
      const names = proto ? Object.getOwnPropertyNames(proto) : [];
      const funcs = {};
      for (const n of names.filter((x) => /buy|shop|spin|start|bonus|option/i.test(x))) {
        const fn = ta?.[n];
        if (typeof fn === 'function') funcs[n] = Function.prototype.toString.call(fn).slice(0, 3000);
      }
      return { names, funcs };
    });
    console.log('ACTIONS_'+name, JSON.stringify(inspect, null, 2));

    await internal.page.evaluate(() => {
      if (typeof window.TestActions?.closeStartScreen === 'function') {
        window.TestActions.closeStartScreen();
      }
    });
    await sleep(800);

    if (name === 'coinup_volcano') {
      const marker = internal.recorder.marker();
      const invoked = await internal.page.evaluate(() => {
        if (typeof window.TestActions?.openBuyFeaturePopup === 'function') window.TestActions.openBuyFeaturePopup();
        if (typeof window.TestActions?.playBuyFeature === 'function') {
          window.TestActions.playBuyFeature(0);
          return true;
        }
        return false;
      });
      console.log('BUY_INVOKED', invoked);
      await internal.recorder.waitForActivityAfter(marker, { timeoutMs: 3000 });
      await internal.recorder.waitForQuiet({ quietMs: 700, timeoutMs: 12000 });
      const events = internal.recorder.eventsAfter(marker);
      for (const req of events.filter((e) => e.type === 'request' && (e.url || '').includes('gsc=play'))) {
        const res = events.find((e) => e.type === 'response' && e.requestId === req.requestId);
        const body = events.find((e) => e.type === 'responsebody' && e.requestId === req.requestId);
        console.log('BUY_NATIVE', JSON.stringify({postData:req.postData,http:res?.status,body:body?.body?.slice(0,2000)}, null, 2));
      }
    } else {
      const marker = internal.recorder.marker();
      const invoked = await internal.page.evaluate(() => {
        const ta = window.TestActions;
        const candidates = Object.getOwnPropertyNames(Object.getPrototypeOf(ta || {}));
        const activate = candidates.find((n) => /activateShopOption/i.test(n));
        if (activate && typeof ta[activate] === 'function') ta[activate](1);
        if (typeof ta?.spin === 'function') {
          ta.spin();
          return {activate, spin:true};
        }
        return {activate, spin:false};
      });
      console.log('BOOST_INVOKED', JSON.stringify(invoked));
      await internal.recorder.waitForActivityAfter(marker, { timeoutMs: 3000 });
      await internal.recorder.waitForQuiet({ quietMs: 700, timeoutMs: 12000 });
      const events = internal.recorder.eventsAfter(marker);
      for (const req of events.filter((e) => e.type === 'request' && (e.url || '').includes('gsc=play'))) {
        const res = events.find((e) => e.type === 'response' && e.requestId === req.requestId);
        const body = events.find((e) => e.type === 'responsebody' && e.requestId === req.requestId);
        console.log('BOOST_NATIVE', JSON.stringify({postData:req.postData,http:res?.status,body:body?.body?.slice(0,2000)}, null, 2));
      }
    }
  } finally {
    await service.closeSession(session.id);
  }
}

try {
  for (const [name,url] of games) await probe(name,url);
} finally {
  await service.stop();
}
