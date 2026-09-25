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

async function invokeNativeSpin(page) {
  return page.evaluate(() => {
    try {
      if (typeof window.TestActions?.spin === 'function') {
        window.TestActions.spin();
        return { invoked: true, hook: 'TestActions.spin' };
      }
      if (typeof window.app?.board?.spin === 'function') {
        window.app.board.spin();
        return { invoked: true, hook: 'app.board.spin' };
      }
      return { invoked: false, reason: 'spin_hook_missing' };
    } catch (error) {
      return { invoked: false, reason: 'spin_hook_failed', error: error?.message || String(error) };
    }
  });
}

async function validateViaPatchedSpin(target) {
  const session = await service.createSession({
    url: target.url,
    skipSplash: false,
    captureInitialScreenshot: false,
  });
  const internal = service.sessions.get(session.id);

  try {
    const initialEvents = internal.recorder.eventsAfter(0);
    const start = extractThreeOaksStart(initialEvents);
    if (!start?.body) return { ...target, error: 'start_missing' };

    const protocol = summarizeThreeOaksStart(start);
    const mode = protocol.available_buy_bonus?.[0];
    if (mode == null) {
      return { ...target, protocol, validation: { skipped: 'no_buy_mode' } };
    }

    // Give client-side controllers a short bounded time to finish constructing.
    const deadline = Date.now() + 5000;
    let spinReady = false;
    while (Date.now() < deadline) {
      spinReady = await internal.page.evaluate(() =>
        typeof window.TestActions?.spin === 'function' ||
        typeof window.app?.board?.spin === 'function'
      );
      if (spinReady) break;
      await sleep(100);
    }
    if (!spinReady) {
      return { ...target, protocol, validation: { error: 'spin_hook_missing' } };
    }

    let patchedRequest = null;
    let patchError = null;
    let intercepted = false;

    const routeHandler = async (route, request) => {
      if (intercepted || request.method() !== 'POST' || !request.url().includes('gsc=play')) {
        await route.continue();
        return;
      }

      intercepted = true;
      try {
        const original = JSON.parse(request.postData() || '{}');
        const originalParams = original.action?.params || {};
        const patched = {
          ...original,
          action: {
            name: 'buy_spin',
            params: {
              ...originalParams,
              bet_per_line: originalParams.bet_per_line ?? start.body.context.spins?.bet_per_line,
              lines: originalParams.lines ?? start.body.context.spins?.lines,
              selected_mode: mode,
            },
          },
        };
        delete patched.action.params.ante_bet;
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
    const marker = internal.recorder.marker();
    const invocation = await invokeNativeSpin(internal.page);

    await internal.recorder.waitForActivityAfter(marker, { timeoutMs: 5000 });
    await internal.recorder.waitForQuiet({ quietMs: 600, timeoutMs: 8000 });
    await internal.page.unroute('**/*', routeHandler);

    let plays = classifyThreeOaksPlay(internal.recorder.eventsAfter(0), marker);

    // Some clients keep the splash layer above the board. A single conservative
    // viewport click followed by the same native spin is the fallback.
    if (plays.length === 0 && invocation.invoked) {
      await internal.page.mouse.click(config.viewport.width / 2, config.viewport.height - 50);
      await sleep(700);

      intercepted = false;
      patchedRequest = null;
      patchError = null;
      await internal.page.route('**/*', routeHandler);
      const retryMarker = internal.recorder.marker();
      const retryInvocation = await invokeNativeSpin(internal.page);
      await internal.recorder.waitForActivityAfter(retryMarker, { timeoutMs: 5000 });
      await internal.recorder.waitForQuiet({ quietMs: 600, timeoutMs: 8000 });
      await internal.page.unroute('**/*', routeHandler);
      plays = classifyThreeOaksPlay(internal.recorder.eventsAfter(0), retryMarker);
      if (plays.length) {
        return {
          ...target,
          protocol,
          validation: {
            mode,
            declared_multiplier: protocol.buy_bonus_prices?.[String(mode)] ?? null,
            invocation: retryInvocation,
            patched: Boolean(patchedRequest),
            patch_error: patchError,
            play: plays.at(-1),
            fallback: 'viewport_click_then_spin',
          },
        };
      }
    }

    return {
      ...target,
      protocol,
      validation: {
        mode,
        declared_multiplier: protocol.buy_bonus_prices?.[String(mode)] ?? null,
        invocation,
        patched: Boolean(patchedRequest),
        patch_error: patchError,
        play: plays.at(-1) ?? null,
        original_request: patchedRequest?.original ?? null,
        patched_request: patchedRequest?.patched ?? null,
      },
    };
  } finally {
    await service.closeSession(session.id);
  }
}

await service.start();
try {
  const results = [];
  for (const target of targets) {
    results.push(await validateViaPatchedSpin(target));
    await sleep(900);
  }

  await fs.mkdir('artifacts/family-inspection', { recursive: true });
  await fs.writeFile(
    path.join('artifacts/family-inspection', 'patched-spin-validation.json'),
    JSON.stringify(results, null, 2),
    'utf8'
  );
  console.log('PATCHED_SPIN_VALIDATION', JSON.stringify(results, null, 2));
} finally {
  await service.stop();
}
