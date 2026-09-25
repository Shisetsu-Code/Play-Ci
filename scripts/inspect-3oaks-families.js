import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import {
  extractThreeOaksStart,
  summarizeThreeOaksStart,
  classifyThreeOaksPlay,
} from '../src/providers/three-oaks.js';

const targets = [
  { family: 'hraymo', url: 'https://3oaks.com/api/v1/games/3_african_drums/play?lang=en' },
  { family: 'goreel', url: 'https://3oaks.com/api/v1/games/3_aztec_temples/play?lang=en' },
  { family: 'ratpack', url: 'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en' },
  { family: 'kendoo', url: 'https://3oaks.com/api/v1/games/3_coin_volcanoes/play?lang=en' },
  { family: 'enjoy', url: 'https://3oaks.com/api/v1/games/3_superpower_diamonds/play?lang=en' },
];

const service = new BrowserService(config);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function dismissBootstrap(page) {
  await sleep(7000);

  const hook = await page.evaluate(() => {
    try {
      const fn = window.TestActions?.closeStartScreen;
      if (typeof fn !== 'function') return { attempted: false, reason: 'missing' };
      const src = Function.prototype.toString.call(fn).replace(/\s+/g, '');
      if (/\{\}$/.test(src)) return { attempted: false, reason: 'stub' };
      fn.call(window.TestActions);
      return { attempted: true, source: src.slice(0, 300) };
    } catch (error) {
      return { attempted: true, error: error?.message || String(error) };
    }
  });

  await sleep(1200);
  await page.mouse.click(config.viewport.width / 2, config.viewport.height - 50);
  await sleep(1800);

  return hook;
}

async function invokeSpin(page) {
  const hook = await page.evaluate(() => {
    try {
      if (typeof window.TestActions?.spin === 'function') {
        window.TestActions.spin();
        return { invoked: true, hook: 'TestActions.spin' };
      }
      if (typeof window.app?.board?.spin === 'function') {
        window.app.board.spin();
        return { invoked: true, hook: 'app.board.spin' };
      }
      return { invoked: false, reason: 'hook_missing' };
    } catch (error) {
      return { invoked: false, reason: 'hook_failed', error: error?.message || String(error) };
    }
  });
  return hook;
}

async function patchedPlay(serviceSession, task) {
  const internal = service.sessions.get(serviceSession.id);
  const initialEvents = internal.recorder.eventsAfter(0);
  const start = extractThreeOaksStart(initialEvents);
  if (!start?.body) return { error: 'start_missing' };

  const protocol = summarizeThreeOaksStart(start);
  const mode = task.kind === 'buy'
    ? protocol.available_buy_bonus?.[0]
    : protocol.available_booster?.[0];

  if (mode == null) return { protocol, error: 'declared_mode_missing' };

  const dismissal = await dismissBootstrap(internal.page);
  let intercepted = false;
  let patchedRequest = null;
  let patchError = null;

  const routeHandler = async (route, request) => {
    if (intercepted || request.method() !== 'POST' || !request.url().includes('gsc=play')) {
      await route.continue();
      return;
    }

    intercepted = true;
    try {
      const original = JSON.parse(request.postData() || '{}');
      const params = {
        ...(original.action?.params || {}),
        bet_per_line: original.action?.params?.bet_per_line ?? start.body.context.spins?.bet_per_line,
        lines: original.action?.params?.lines ?? start.body.context.spins?.lines,
        selected_mode: mode,
      };

      let actionName = 'buy_spin';
      if (task.kind === 'booster') {
        actionName = 'spin';
        params.ante_bet = Number(protocol.booster_prices?.[String(mode)]);
      } else {
        delete params.ante_bet;
      }

      const patched = {
        ...original,
        action: { name: actionName, params },
      };
      patchedRequest = { original, patched };

      await route.continue({
        postData: JSON.stringify(patched),
        headers: {
          ...request.headers(),
          'content-type': 'text/plain',
        },
      });
    } catch (error) {
      patchError = error?.message || String(error);
      await route.continue();
    }
  };

  await internal.page.route('**/*', routeHandler);
  let marker = internal.recorder.marker();
  let invocation = await invokeSpin(internal.page);

  await internal.recorder.waitForActivityAfter(marker, { timeoutMs: 3500 });
  await internal.recorder.waitForQuiet({ quietMs: 500, timeoutMs: 5500 });
  let plays = classifyThreeOaksPlay(internal.recorder.eventsAfter(0), marker);

  if (plays.length === 0) {
    // Fixed viewport + DPR=1 means this is the stable right-side spin control in
    // the 3 Oaks game shell. It is a fallback only after the hook produced no play.
    intercepted = false;
    patchedRequest = null;
    patchError = null;
    marker = internal.recorder.marker();
    await internal.page.mouse.click(1195, 355);
    invocation = { invoked: true, hook: 'viewport_spin_fallback', x: 1195, y: 355 };
    await internal.recorder.waitForActivityAfter(marker, { timeoutMs: 3500 });
    await internal.recorder.waitForQuiet({ quietMs: 500, timeoutMs: 5500 });
    plays = classifyThreeOaksPlay(internal.recorder.eventsAfter(0), marker);
  }

  await internal.page.unroute('**/*', routeHandler);

  return {
    protocol,
    dismissal,
    task,
    invocation,
    intercepted,
    patch_error: patchError,
    original_request: patchedRequest?.original ?? null,
    patched_request: patchedRequest?.patched ?? null,
    play: plays.at(-1) ?? null,
  };
}

await service.start();
try {
  const results = [];
  for (const target of targets) {
    const session = await service.createSession({
      url: target.url,
      skipSplash: false,
      captureInitialScreenshot: false,
    });
    try {
      results.push({
        ...target,
        result: await patchedPlay(session, { kind: 'buy' }),
      });
    } finally {
      await service.closeSession(session.id);
    }
    await sleep(1000);
  }

  await fs.mkdir('artifacts/family-inspection', { recursive: true });
  await fs.writeFile(
    path.join('artifacts/family-inspection', 'bootstrap-patched-spin.json'),
    JSON.stringify(results, null, 2),
    'utf8'
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await service.stop();
}
