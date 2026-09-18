import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const targets = [
  { id: 'dragon_pearls', url: 'https://3oaks.com/api/v1/games/4_dragon_pearls/play?lang=en' },
  { id: 'coinup_volcano', url: 'https://3oaks.com/api/v1/games/coinup_volcano/play?lang=en' },
  { id: 'lucky_penny_3_pots_super_wheel', url: 'https://3oaks.com/api/v1/games/lucky_penny_3_pots_super_wheel/play?lang=en' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const service = new BrowserService(config);

function parseJsonBody(event) {
  try { return JSON.parse(event.body); } catch { return null; }
}

function findStart(events) {
  for (const event of events) {
    if (event.type !== 'responsebody' || !event.body) continue;
    const body = parseJsonBody(event);
    if (body?.command === 'start') return body;
  }
  return null;
}

function summarizeStart(body) {
  if (!body) return null;
  const ctx = body.context || {};
  const s = body.settings || {};
  return {
    actions: ctx.actions || [],
    available_buy_bonus: ctx.available_buy_bonus || [],
    available_booster: ctx.available_booster || [],
    buy_bonus_prices: s.buy_bonus_prices || {},
    booster_prices: s.booster_prices || {},
    bets: s.bets || [],
    bet_factor: s.bet_factor || [],
    lines: s.lines || [],
    denominator: s.currency_format?.denominator ?? null,
    initial_bet_per_line: ctx.spins?.bet_per_line ?? null,
    initial_lines: ctx.spins?.lines ?? null,
  };
}

function playSlice(events) {
  const requests = events.filter((e) =>
    e.type === 'request' &&
    e.method === 'POST' &&
    /betman-demo\.head\.3oaks\.com/.test(e.url || '') &&
    (e.url || '').includes('gsc=play')
  );
  return requests.map((req) => {
    let parsed = null;
    try { parsed = JSON.parse(req.postData || 'null'); } catch {}
    const response = events.find((e) => e.type === 'response' && e.requestId === req.requestId);
    const bodyEvent = events.find((e) => e.type === 'responsebody' && e.requestId === req.requestId);
    let responseBody = null;
    if (bodyEvent?.body) {
      try { responseBody = JSON.parse(bodyEvent.body); } catch { responseBody = bodyEvent.body; }
    }
    return {
      request: parsed ?? req.postData,
      status: response?.status ?? null,
      response: responseBody,
    };
  });
}

async function discover(target) {
  const session = await service.createSession({
    url: target.url,
    skipSplash: false,
    captureInitialScreenshot: false,
  });
  try {
    const internal = service.sessions.get(session.id);
    const start = findStart(internal.recorder.eventsAfter(0));
    return { target, sessionId: session.id, start: summarizeStart(start), rawStartFound: Boolean(start) };
  } finally {
    await service.closeSession(session.id);
  }
}

async function waitForGameReady(page) {
  await page.mouse.click(640, 670);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => Boolean(window.app?.board));
    if (ready) return true;
    await sleep(100);
  }
  return false;
}

async function validateAction(task) {
  const session = await service.createSession({
    url: task.target.url,
    skipSplash: false,
    captureInitialScreenshot: false,
  });
  const internal = service.sessions.get(session.id);
  try {
    const ready = await waitForGameReady(internal.page);
    if (!ready) return { ...task, ok: false, error: 'game_not_ready' };

    if (task.kind === 'booster') {
      const hasSetter = await internal.page.evaluate(() => typeof window.TestActions?.activateShopOption === 'function');
      if (!hasSetter) return { ...task, ok: false, error: 'booster_setter_missing' };
      await internal.page.evaluate((m) => window.TestActions.activateShopOption(m), task.mode);
      await sleep(150);
    }

    const marker = internal.recorder.marker();

    if (task.kind === 'buy') {
      const hasBuy = await internal.page.evaluate(() => typeof window.app?.board?.buyFeature?.actBuyFeature === 'function');
      if (!hasBuy) return { ...task, ok: false, error: 'buy_feature_missing' };
      await internal.page.evaluate((m) => window.app.board.buyFeature.actBuyFeature(m), task.mode);
    } else {
      await internal.page.mouse.move(1195, 357);
      await internal.page.mouse.down();
      await sleep(90);
      await internal.page.mouse.up();
    }

    const activity = await internal.recorder.waitForActivityAfter(marker, { timeoutMs: 2000 });
    const quiet = await internal.recorder.waitForQuiet({ quietMs: 500, timeoutMs: 8000 });
    const events = internal.recorder.eventsAfter(marker);
    const plays = playSlice(events);
    return { ...task, ok: plays.length > 0, activity, quiet, plays };
  } catch (error) {
    return { ...task, ok: false, error: error.message };
  } finally {
    await service.closeSession(session.id);
  }
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

await service.start();
try {
  const discoveries = await Promise.all(targets.map(discover));
  console.log('DISCOVERIES', JSON.stringify(discoveries, null, 2));

  const tasks = [];
  for (const d of discoveries) {
    const s = d.start || {};
    tasks.push({ target: d.target, kind: 'spin', mode: null });
    for (const mode of s.available_booster || []) tasks.push({ target: d.target, kind: 'booster', mode });
    for (const mode of s.available_buy_bonus || []) tasks.push({ target: d.target, kind: 'buy', mode });
  }

  const validations = await pool(tasks, 6, validateAction);
  const report = {
    generatedAt: new Date().toISOString(),
    discoveries,
    validations,
  };

  await fs.mkdir(config.artifactDir, { recursive: true });
  await fs.writeFile(path.join(config.artifactDir, 'probe-results.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('REPORT', JSON.stringify(report, null, 2));
} finally {
  await service.stop();
}
