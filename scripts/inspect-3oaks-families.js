import fs from 'node:fs/promises';
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

async function inspectObject(page, expression) {
  return page.evaluate((expr) => {
    const source = (fn) => {
      try { return Function.prototype.toString.call(fn).slice(0, 1200); } catch { return null; }
    };
    let obj;
    try { obj = (0, eval)(expr); } catch { return null; }
    if (!obj) return null;
    const own = Object.getOwnPropertyNames(obj);
    const proto = Object.getPrototypeOf(obj);
    const protoNames = proto ? Object.getOwnPropertyNames(proto) : [];
    const keys = [...new Set([...own, ...protoNames])];
    const functions = {};
    const values = {};
    for (const key of keys) {
      let value;
      try { value = obj[key]; } catch { continue; }
      if (typeof value === 'function') {
        if (/buy|shop|bonus|spin|option|feature|click|show|hide|skip|select|activate|open|close/i.test(key)) {
          functions[key] = source(value);
        }
      } else if (/buy|shop|bonus|spin|option|feature|visible|enabled|active|selected|mode/i.test(key)) {
        if (value == null || ['string','number','boolean'].includes(typeof value)) values[key] = value;
      }
    }
    return { own, proto: protoNames, functions, values };
  }, expression);
}

async function dismissStart(page) {
  const attempt = await page.evaluate(() => {
    const ta = window.TestActions;
    try {
      if (ta && typeof ta.closeStartScreen === 'function') {
        const src = Function.prototype.toString.call(ta.closeStartScreen).replace(/\s+/g, '');
        if (!/\{\}$/.test(src)) {
          ta.closeStartScreen();
          return 'TestActions.closeStartScreen';
        }
      }
    } catch {}
    try {
      if (window.app?.startScreen?.skip) {
        window.app.startScreen.skip();
        return 'app.startScreen.skip';
      }
    } catch {}
    return null;
  });
  if (attempt) {
    await sleep(1500);
    return attempt;
  }
  await page.mouse.click(config.viewport.width / 2, config.viewport.height - 50);
  await sleep(1800);
  return 'viewport_click';
}

async function openBuy(page) {
  return page.evaluate(() => {
    const srcEmpty = (fn) => {
      try { return /\{\}$/.test(Function.prototype.toString.call(fn).replace(/\s+/g,'')); } catch { return true; }
    };

    const attempts = [
      ['TestActions.openBuyFeaturePopup', () => window.TestActions?.openBuyFeaturePopup],
      ['app.board._onBuyFeatureButton', () => window.app?.board?._onBuyFeatureButton],
      ['app.board.buyFeaturePopup.show', () => window.app?.board?.buyFeaturePopup?.show],
      ['GR.UI.view.buy_feature.click', () => window.GR?.UI?.view?.buy_feature?.click],
      ['GR.UI.view.buy_feature.emit', () => window.GR?.UI?.view?.buy_feature?.emit],
    ];

    for (const [name, getter] of attempts) {
      let fn;
      try { fn = getter(); } catch { continue; }
      if (typeof fn !== 'function') continue;
      if (name.startsWith('TestActions') && srcEmpty(fn)) continue;
      try {
        if (name === 'app.board._onBuyFeatureButton') {
          fn.call(window.app.board);
        } else if (name === 'app.board.buyFeaturePopup.show') {
          fn.call(window.app.board.buyFeaturePopup);
        } else if (name === 'GR.UI.view.buy_feature.click') {
          fn.call(window.GR.UI.view.buy_feature);
        } else if (name === 'GR.UI.view.buy_feature.emit') {
          fn.call(window.GR.UI.view.buy_feature, 'pointertap');
        } else {
          fn.call(window.TestActions);
        }
        return { opened: true, method: name };
      } catch (error) {
        return { opened: false, method: name, error: error.message };
      }
    }
    return { opened: false, method: null };
  });
}

async function inspectOne(target) {
  const session = await service.createSession({
    url: target.url,
    skipSplash: false,
    captureInitialScreenshot: false,
  });
  const internal = service.sessions.get(session.id);
  try {
    await sleep(2500);
    const dismissal = await dismissStart(internal.page);
    await sleep(1200);

    const before = {};
    const expressions = [
      'window.TestActions',
      'window.app',
      'window.app?.board',
      'window.app?.board?.buyFeature',
      'window.app?.board?.buyFeatureButton',
      'window.app?.board?.buyFeaturePopup',
      'window.GR?.UI',
      'window.GR?.UI?.view',
      'window.GR?.UI?.view?.buy_feature',
      'window.GR?.UI?.view?.shop_button',
      'window.GR?.UI?.model',
    ];
    for (const expr of expressions) before[expr] = await inspectObject(internal.page, expr);

    const openResult = await openBuy(internal.page);
    await sleep(1000);

    const after = {};
    const afterExpressions = [
      'window.app?.board?.buyFeature',
      'window.app?.board?.buyFeatureButton',
      'window.app?.board?.buyFeaturePopup',
      'window.app?.buyFeature',
      'window.GR?.UI?.view?.buy_feature',
      'window.GR?.UI?.view?.buy_feature_popup',
      'window.GR?.UI?.view?.buy_feature_options',
      'window.GR?.UI?.view?.shop_button',
    ];
    for (const expr of afterExpressions) after[expr] = await inspectObject(internal.page, expr);

    const matchingProps = await internal.page.evaluate(() => {
      const scan = (obj, prefix, depth = 0, seen = new WeakSet()) => {
        const out = [];
        if (!obj || (typeof obj !== 'object' && typeof obj !== 'function') || depth > 2) return out;
        if (typeof obj === 'object' || typeof obj === 'function') {
          if (seen.has(obj)) return out;
          seen.add(obj);
        }
        let keys = [];
        try { keys = Object.getOwnPropertyNames(obj); } catch { return out; }
        for (const key of keys) {
          if (!/buy|shop|bonus|feature|option/i.test(key)) continue;
          let value;
          try { value = obj[key]; } catch { continue; }
          out.push({
            path: prefix ? `${prefix}.${key}` : key,
            type: typeof value,
            ctor: value?.constructor?.name || null,
            keys: value && (typeof value === 'object' || typeof value === 'function')
              ? (() => { try { return Object.getOwnPropertyNames(value).slice(0,60); } catch { return []; } })()
              : [],
          });
        }
        return out;
      };
      return [
        ...scan(window.app, 'app'),
        ...scan(window.app?.board, 'app.board'),
        ...scan(window.GR?.UI?.view, 'GR.UI.view'),
        ...scan(window.GR?.UI?.model, 'GR.UI.model'),
      ];
    });

    return {
      ...target,
      dismissal,
      openResult,
      before,
      after,
      matchingProps,
    };
  } finally {
    await service.closeSession(session.id);
  }
}

await service.start();
try {
  const results = [];
  for (const target of targets) {
    try {
      results.push(await inspectOne(target));
    } catch (error) {
      results.push({ ...target, error: error.message });
    }
  }
  await fs.mkdir('artifacts/family-inspection', { recursive: true });
  await fs.writeFile(
    'artifacts/family-inspection/families-after-start.json',
    JSON.stringify(results, null, 2),
    'utf8',
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await service.stop();
}
