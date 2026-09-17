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
    /betman-demo\.head\.3oaks\.com/.test(e.url || '') &&
    (e.url || '').includes('gsc=play')
  );
}

async function openGame() {
  const session = await service.createSession({ url, skipSplash: true });
  const internal = service.sessions.get(session.id);
  await internal.page.mouse.move(640, 670);
  await internal.page.mouse.down();
  await sleep(80);
  await internal.page.mouse.up();
  await sleep(2500);
  return { session, internal };
}

async function probe(label, fn) {
  const { session, internal } = await openGame();
  try {
    const marker = internal.recorder.marker();
    const availability = await internal.page.evaluate(() => ({
      appReady: Boolean(window.app?.board),
      buyFeatureReady: Boolean(window.app?.board?.buyFeature?.actBuyFeature),
      boosterSetterReady: Boolean(window.TestActions?.activateShopOption),
      actions: window.GR?.Flow?.get?.('context.actions') || null,
    }));

    await fn(internal.page);
    // Do not declare "quiet" before delayed game events have had a chance to issue HTTP.
    await sleep(1200);
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
  for (const mode of [1, 2]) {
    await probe(`buy_${mode}`, async (page) => {
      await page.evaluate((m) => window.app.board.buyFeature.actBuyFeature(m), mode);
    });
  }

  await probe('booster_1_spin', async (page) => {
    await page.evaluate(() => window.TestActions.activateShopOption(1));
    await sleep(200);
    // Trigger the game's own spin control through its pointer surface.
    await page.mouse.move(1195, 357);
    await page.mouse.down();
    await sleep(100);
    await page.mouse.up();
  });

  await fs.mkdir(config.artifactDir, { recursive: true });
  await fs.writeFile(path.join(config.artifactDir, 'probe-results.json'), JSON.stringify(results, null, 2), 'utf8');
} finally {
  await service.stop();
}
