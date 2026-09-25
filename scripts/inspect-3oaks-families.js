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

async function dismiss(page) {
  const result = await page.evaluate(() => {
    try {
      const fn = window.TestActions?.closeStartScreen;
      if (typeof fn === 'function') {
        const src = Function.prototype.toString.call(fn).replace(/\s+/g, '');
        if (!/\{\}$/.test(src)) {
          fn.call(window.TestActions);
          return { method: 'TestActions.closeStartScreen', source: src.slice(0, 300) };
        }
      }
    } catch (error) {
      return { method: 'hook_failed', error: error?.message || String(error) };
    }
    return { method: 'none' };
  });

  await sleep(1200);

  if (result.method === 'none' || result.method === 'hook_failed') {
    await page.mouse.click(config.viewport.width / 2, config.viewport.height - 50);
    await sleep(2200);
    return { ...result, fallback: 'viewport-bottom-center' };
  }

  await sleep(1200);
  return result;
}

await service.start();
try {
  const meta = [];
  for (const target of targets) {
    const session = await service.createSession({
      url: target.url,
      skipSplash: false,
      captureInitialScreenshot: false,
    });
    const internal = service.sessions.get(session.id);
    try {
      const dismissal = await dismiss(internal.page);
      const screenshot = await service.capture(session.id, `family-${target.family}`);
      meta.push({
        ...target,
        dismissal,
        screenshot,
        testActions: await internal.page.evaluate(() => ({
          type: typeof window.TestActions,
          hasSpin: typeof window.TestActions?.spin === 'function',
          hasCloseStart: typeof window.TestActions?.closeStartScreen === 'function',
          appBoardSpin: typeof window.app?.board?.spin === 'function',
        })),
      });
    } finally {
      await service.closeSession(session.id);
    }
  }

  await fs.mkdir('artifacts/family-inspection', { recursive: true });
  await fs.writeFile(
    path.join('artifacts/family-inspection', 'screenshots.json'),
    JSON.stringify(meta, null, 2),
    'utf8'
  );

  // Copy screenshots into one flat artifact folder for easy inspection.
  for (const item of meta) {
    const source = path.resolve(item.screenshot.path);
    const dest = path.join('artifacts/family-inspection', `${item.family}.png`);
    await fs.copyFile(source, dest);
  }

  console.log(JSON.stringify(meta, null, 2));
} finally {
  await service.stop();
}
