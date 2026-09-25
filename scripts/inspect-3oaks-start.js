import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const games = [
  ['coinup_volcano', 'https://3oaks.com/api/v1/games/coinup_volcano/play?lang=en'],
  ['4_super_clover_pots', 'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en'],
];
const service = new BrowserService(config);
await service.start();

async function networkResult(internal, marker, label) {
  await internal.recorder.waitForActivityAfter(marker, { timeoutMs: 5000 });
  await internal.recorder.waitForQuiet({ quietMs: 800, timeoutMs: 15000 });
  const events = internal.recorder.eventsAfter(marker);
  const rows = [];
  for (const req of events.filter((e) => e.type === 'request' && (e.url || '').includes('gsc=play'))) {
    const res = events.find((e) => e.type === 'response' && e.requestId === req.requestId);
    const body = events.find((e) => e.type === 'responsebody' && e.requestId === req.requestId);
    rows.push({ postData:req.postData, http:res?.status, body:body?.body?.slice(0,3000) || null });
  }
  console.log(label, JSON.stringify(rows, null, 2));
}

async function probe(name, url) {
  const session = await service.createSession({ url, skipSplash:false, captureInitialScreenshot:false });
  const internal = service.sessions.get(session.id);
  try {
    await sleep(1200);
    const inspect = await internal.page.evaluate(() => {
      const raw = window.TestActions;
      const isClass = typeof raw === 'function';
      return {
        type: typeof raw,
        own: raw ? Object.getOwnPropertyNames(raw) : [],
        rawSource: typeof raw === 'function' ? Function.prototype.toString.call(raw).slice(0,3000) : null,
        prototypeNames: isClass && raw.prototype ? Object.getOwnPropertyNames(raw.prototype) : [],
        instanceProtoNames: raw && typeof raw === 'object' ? Object.getOwnPropertyNames(Object.getPrototypeOf(raw)) : [],
      };
    });
    console.log('SHAPE_'+name, JSON.stringify(inspect, null, 2));

    const resolved = await internal.page.evaluate(() => {
      const raw = window.TestActions;
      if (raw && typeof raw === 'object') {
        window.__playCiTA = raw;
        return {kind:'instance'};
      }
      if (typeof raw === 'function') {
        const attempts = [
          () => new raw(window.app),
          () => new raw(),
        ];
        for (const make of attempts) {
          try {
            const v = make();
            if (v) {
              window.__playCiTA = v;
              return {kind:'constructed', names:Object.getOwnPropertyNames(Object.getPrototypeOf(v))};
            }
          } catch (error) {}
        }
        return {kind:'class-unresolved'};
      }
      return {kind:'missing'};
    });
    console.log('RESOLVED_'+name, JSON.stringify(resolved));

    await internal.page.evaluate(() => window.__playCiTA?.closeStartScreen?.());
    await sleep(1000);

    if (name === 'coinup_volcano') {
      const marker = internal.recorder.marker();
      await internal.page.evaluate(() => window.__playCiTA?.openBuyFeaturePopup?.());
      await sleep(800);
      await internal.page.evaluate(() => window.__playCiTA?.playBuyFeature?.(0));
      await sleep(800);
      await internal.page.evaluate(() => window.__playCiTA?.spin?.());
      await networkResult(internal, marker, 'COINUP_BUY_NATIVE');
      const shot = await service.capture(session.id, 'coinup-after-buy-flow');
      console.log('SHOT', JSON.stringify(shot));
    } else {
      const methods = await internal.page.evaluate(() => {
        const ta=window.__playCiTA;
        if (!ta) return {};
        const names=Object.getOwnPropertyNames(Object.getPrototypeOf(ta));
        const out={};
        for (const n of names.filter(x=>/buy|shop|spin|start|bonus|option/i.test(x))) {
          if (typeof ta[n] === 'function') out[n]=Function.prototype.toString.call(ta[n]).slice(0,3000);
        }
        return out;
      });
      console.log('SUPER_METHODS', JSON.stringify(methods, null, 2));
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
