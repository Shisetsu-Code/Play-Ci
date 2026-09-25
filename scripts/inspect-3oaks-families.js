import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const targets = [
  { family: 'hraymo', url: 'https://3oaks.com/api/v1/games/3_african_drums/play?lang=en' },
  { family: 'goreel', url: 'https://3oaks.com/api/v1/games/3_aztec_temples/play?lang=en' },
  { family: 'ratpack', url: 'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en' },
  { family: 'kendoo', url: 'https://3oaks.com/api/v1/games/3_coin_volcanoes/play?lang=en' },
  { family: 'enjoy', url: 'https://3oaks.com/api/v1/games/3_superpower_diamonds/play?lang=en' },
];

const service = new BrowserService(config);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function source(fn) {
  try { return Function.prototype.toString.call(fn).slice(0, 1800); } catch { return null; }
}

async function inspectOne(target) {
  const session = await service.createSession({
    url: target.url,
    skipSplash: false,
    captureInitialScreenshot: false,
  });
  const internal = service.sessions.get(session.id);
  try {
    await sleep(3500);
    const result = await internal.page.evaluate(() => {
      const src = (fn) => {
        try { return Function.prototype.toString.call(fn).slice(0, 1800); } catch { return null; }
      };
      const describe = (obj) => {
        if (!obj) return null;
        const own = Object.getOwnPropertyNames(obj);
        const proto = Object.getPrototypeOf(obj);
        const protoNames = proto ? Object.getOwnPropertyNames(proto) : [];
        const names = [...new Set([...own, ...protoNames])];
        const functions = {};
        for (const name of names) {
          let value;
          try { value = obj[name]; } catch { continue; }
          if (typeof value === 'function') functions[name] = src(value);
        }
        return { own, proto: protoNames, functions };
      };

      const ta = window.TestActions;
      const app = window.app;
      const board = app?.board;
      const buyFeature = board?.buyFeature;
      const shop = board?.shop || board?.booster || board?.featureShop;

      const interestingGlobals = Object.getOwnPropertyNames(window)
        .filter((name) => /buy|bonus|shop|booster|spin|feature/i.test(name))
        .slice(0, 100);

      return {
        url: location.href,
        readyState: document.readyState,
        testActionsType: typeof ta,
        testActions: describe(ta),
        app: describe(app),
        board: describe(board),
        buyFeature: describe(buyFeature),
        shop: describe(shop),
        interestingGlobals,
        grContext: (() => {
          try {
            const ctx = window.GR?.Flow?.get?.('context');
            return ctx ? {
              actions: ctx.actions,
              available_buy_bonus: ctx.available_buy_bonus,
              available_booster: ctx.available_booster,
            } : null;
          } catch { return null; }
        })(),
      };
    });
    return { ...target, result };
  } finally {
    await service.closeSession(session.id);
  }
}

await service.start();
try {
  const results = await Promise.all(targets.map(inspectOne));
  await fs.mkdir('artifacts/family-inspection', { recursive: true });
  await fs.writeFile(
    path.join('artifacts/family-inspection', 'families.json'),
    JSON.stringify(results, null, 2),
    'utf8'
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await service.stop();
}
