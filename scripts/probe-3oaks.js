import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const url = 'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en';
const service = new BrowserService(config);
const results = [];

function compact(events) {
  return events.filter((e) =>
    (e.type === 'request' || e.type === 'response' || e.type === 'responsebody') &&
    (/betman-demo\.head\.3oaks\.com/.test(e.url || '')) &&
    ((e.url || '').includes('gsc=play'))
  );
}

async function openGame() {
  const session = await service.createSession({ url, skipSplash: true });
  await service.click(session.id, { x: 640, y: 670, settleTimeoutMs: 8000 });
  await sleep(2500);
  return { session, internal: service.sessions.get(session.id) };
}

async function probe(label, fn) {
  const { session, internal } = await openGame();
  try {
    const marker = internal.recorder.marker();
    const availability = await internal.page.evaluate(() => ({
      testActions: Object.keys(window.TestActions || {}),
      appReady: Boolean(window.app?.board),
    }));
    await fn(internal.page);
    const quiet = await internal.recorder.waitForQuiet({ quietMs: 800, timeoutMs: 12000 });
    const events = internal.recorder.eventsAfter(marker);
    const playEvents = compact(events);
    results.push({ label, availability, quiet, playEvents });
    console.log('PROBE_RESULT', JSON.stringify(results.at(-1), null, 2));
  } finally {
    await service.closeSession(session.id);
  }
}

try {
  await probe('base_spin', async (page) => {
    await page.mouse.move(1195, 357);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.up();
  });

  for (const mode of [1, 2, 3]) {
    await probe(`booster_${mode}`, async (page) => {
      await page.evaluate((m) => window.TestActions.activateShopOption(m), mode);
      await sleep(150);
      await page.mouse.move(1195, 357);
      await page.mouse.down();
      await sleep(80);
      await page.mouse.up();
    });
  }

  for (const mode of [1, 2]) {
    await probe(`buy_${mode}`, async (page) => {
      await page.evaluate((m) => window.TestActions.playBuyFeature(m), mode);
    });
  }

  await fs.mkdir(config.artifactDir, { recursive: true });
  await fs.writeFile(
    path.join(config.artifactDir, 'probe-results.json'),
    JSON.stringify(results, null, 2),
    'utf8',
  );
} finally {
  await service.stop();
}
