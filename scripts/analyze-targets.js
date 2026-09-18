import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { parseTargetList } from '../src/target-list.js';

const TARGET_FILE = path.resolve(process.env.TARGET_FILE || 'analysis/targets.txt');
const OUTPUT_DIR = path.resolve(process.env.ANALYSIS_OUTPUT_DIR || 'artifacts/analysis');
const DISCOVERY_CONCURRENCY = Number.parseInt(process.env.ANALYSIS_DISCOVERY_CONCURRENCY || '4', 10);
const VALIDATION_CONCURRENCY = Number.parseInt(process.env.ANALYSIS_VALIDATION_CONCURRENCY || '6', 10);

function jsonBody(event) {
  if (event?.type !== 'responsebody' || !event.body) return null;
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

function pool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(limit, items.length || 1));

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        results[index] = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  return Promise.all(Array.from({ length: count }, worker)).then(() => results);
}

function extractThreeOaksStart(events) {
  for (const event of events) {
    const body = jsonBody(event);
    if (body?.command !== 'start' || !body?.context || !body?.settings) continue;

    const request = events.find((candidate) =>
      candidate.type === 'request' &&
      candidate.requestId === event.requestId
    );

    return {
      body,
      requestUrl: request?.url || event.url || null,
    };
  }
  return null;
}

function firstNumber(value) {
  if (Array.isArray(value)) return value.find((entry) => Number.isFinite(Number(entry))) ?? null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function summarizeThreeOaksStart(start) {
  const body = start.body;
  const context = body.context || {};
  const settings = body.settings || {};
  const denominator = Number(settings.currency_format?.denominator || 1);
  const betFactor = firstNumber(settings.bet_factor);
  const betPerLine = Number(context.spins?.bet_per_line ?? context.last_args?.bet_per_line ?? 0);
  const displayBet = betFactor && denominator
    ? (betPerLine * betFactor) / denominator
    : null;

  return {
    provider: '3oaks',
    session_id_present: Boolean(body.session_id),
    actions: context.actions || [],
    available_buy_bonus: context.available_buy_bonus || [],
    available_booster: context.available_booster || [],
    buy_bonus_prices: settings.buy_bonus_prices || {},
    booster_prices: settings.booster_prices || {},
    bets: settings.bets || [],
    bet_factor: settings.bet_factor ?? null,
    denominator,
    initial_bet_per_line: context.spins?.bet_per_line ?? null,
    initial_lines: context.spins?.lines ?? null,
    display_bet: displayBet,
  };
}

function summarizeGeneric(events) {
  const observed = [];
  for (const event of events) {
    const body = jsonBody(event);
    if (!body || typeof body !== 'object') continue;
    observed.push({
      url: event.url,
      keys: Object.keys(body).slice(0, 30),
      command: typeof body.command === 'string' ? body.command : null,
    });
    if (observed.length >= 20) break;
  }
  return observed;
}

function threeOaksPlayUrl(start) {
  if (!start.requestUrl) throw new Error('3Oaks start request URL was not captured');
  const url = new URL(start.requestUrl);
  url.searchParams.set('gsc', 'play');
  return url.toString();
}

function buildThreeOaksPayload(startBody, kind, mode) {
  const context = startBody.context || {};
  const settings = startBody.settings || {};
  const params = {
    bet_per_line: context.spins?.bet_per_line,
    lines: context.spins?.lines,
  };

  if (kind === 'buy') {
    params.selected_mode = mode;
  } else if (kind === 'booster') {
    params.ante_bet = Number(settings.booster_prices?.[String(mode)]);
    params.selected_mode = mode;
  }

  return {
    command: 'play',
    request_id: crypto.randomUUID().replaceAll('-', ''),
    session_id: startBody.session_id,
    action: {
      name: kind === 'buy' ? 'buy_spin' : 'spin',
      params,
    },
    set_denominator: 1,
    quick_spin: 1,
    sound: true,
    autogame: false,
    mobile: '0',
    portrait: false,
    fullscreen: true,
    viewportSize: `${config.viewport.width}x${config.viewport.height}`,
    client_command_timestamp: Date.now(),
  };
}

function compactThreeOaksResponse(responseBody, httpStatus) {
  return {
    http_status: httpStatus,
    server_status: responseBody?.status ?? null,
    command: responseBody?.command ?? null,
    last_action: responseBody?.context?.last_action ?? null,
    last_args: responseBody?.context?.last_args ?? null,
    next_actions: responseBody?.context?.actions ?? null,
    round_finished: responseBody?.context?.round_finished ?? null,
    balance: responseBody?.user?.balance ?? null,
    currency: responseBody?.user?.currency ?? null,
    error: responseBody?.error ?? null,
  };
}

async function discover(service, url) {
  const started = Date.now();
  const session = await service.createSession({
    url,
    skipSplash: false,
    captureInitialScreenshot: false,
  });

  try {
    const internal = service.sessions.get(session.id);
    const events = internal.recorder.eventsAfter(0);
    const threeOaks = extractThreeOaksStart(events);

    if (threeOaks) {
      return {
        ok: true,
        url,
        provider: '3oaks',
        status: 'DISCOVERED',
        duration_ms: Date.now() - started,
        protocol: summarizeThreeOaksStart(threeOaks),
        start: threeOaks,
      };
    }

    return {
      ok: true,
      url,
      provider: 'unknown',
      status: 'REQUIRES_REVIEW',
      duration_ms: Date.now() - started,
      observed_json: summarizeGeneric(events),
    };
  } finally {
    await service.closeSession(session.id);
  }
}

async function validateThreeOaks(service, discovery, task) {
  const started = Date.now();
  const session = await service.createSession({
    url: discovery.url,
    skipSplash: false,
    captureInitialScreenshot: false,
  });

  try {
    const internal = service.sessions.get(session.id);
    const freshStart = extractThreeOaksStart(internal.recorder.eventsAfter(0));
    if (!freshStart) throw new Error('3Oaks start response missing in validation session');

    const payload = buildThreeOaksPayload(freshStart.body, task.kind, task.mode);
    const playUrl = threeOaksPlayUrl(freshStart);

    const response = await internal.context.request.post(playUrl, {
      headers: {
        'content-type': 'text/plain',
        referer: 'https://3oaks.com/',
      },
      data: JSON.stringify(payload),
      failOnStatusCode: false,
    });

    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw_text: text.slice(0, 1000) };
    }

    const compact = compactThreeOaksResponse(body, response.status());
    const accepted =
      response.status() >= 200 &&
      response.status() < 300 &&
      compact.server_status?.code === 'OK';

    return {
      ok: accepted,
      url: discovery.url,
      provider: '3oaks',
      kind: task.kind,
      mode: task.mode,
      duration_ms: Date.now() - started,
      declared_multiplier:
        task.kind === 'buy'
          ? freshStart.body.settings?.buy_bonus_prices?.[String(task.mode)] ?? null
          : task.kind === 'booster'
            ? freshStart.body.settings?.booster_prices?.[String(task.mode)] ?? null
            : 1,
      request: {
        action: payload.action,
        set_denominator: payload.set_denominator,
        quick_spin: payload.quick_spin,
        autogame: payload.autogame,
      },
      response: compact,
    };
  } finally {
    await service.closeSession(session.id);
  }
}

function validationTasks(discoveries) {
  const tasks = [];
  for (const discovery of discoveries) {
    if (!discovery?.ok || discovery.provider !== '3oaks') continue;

    const protocol = discovery.protocol || {};
    if ((protocol.actions || []).includes('spin')) {
      tasks.push({ discovery, kind: 'spin', mode: null });
    }

    for (const mode of protocol.available_booster || []) {
      tasks.push({ discovery, kind: 'booster', mode });
    }

    for (const mode of protocol.available_buy_bonus || []) {
      tasks.push({ discovery, kind: 'buy', mode });
    }
  }
  return tasks;
}

function markdown(report) {
  const lines = [
    '# Play-Ci analysis report',
    '',
    `Generated: ${report.generated_at}`,
    `Targets: ${report.targets.length}`,
    `Duration: ${(report.duration_ms / 1000).toFixed(2)} s`,
    '',
  ];

  for (const target of report.targets) {
    lines.push(`## ${target.url}`, '');
    lines.push(`- Provider: ${target.provider || 'unknown'}`);
    lines.push(`- Status: ${target.status || (target.ok ? 'OK' : 'FAILED')}`);
    lines.push(`- Discovery: ${target.duration_ms ?? '?'} ms`);

    if (target.protocol) {
      lines.push(`- Actions: ${JSON.stringify(target.protocol.actions || [])}`);
      lines.push(`- Buy modes: ${JSON.stringify(target.protocol.available_buy_bonus || [])}`);
      lines.push(`- Buy prices: ${JSON.stringify(target.protocol.buy_bonus_prices || {})}`);
      lines.push(`- Boosters: ${JSON.stringify(target.protocol.available_booster || [])}`);
      lines.push(`- Booster prices: ${JSON.stringify(target.protocol.booster_prices || {})}`);
    }

    const validations = report.validations.filter((entry) => entry.url === target.url);
    if (validations.length) {
      lines.push('', 'Validations:');
      for (const item of validations) {
        lines.push(
          `- ${item.kind}${item.mode == null ? '' : ` mode ${item.mode}`}: ${item.ok ? 'OK' : 'FAILED'}; HTTP ${item.response?.http_status ?? '?'}; multiplier ${item.declared_multiplier ?? '?'}`
        );
      }
    }

    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

const runStarted = Date.now();
const targetText = await fs.readFile(TARGET_FILE, 'utf8');
const urls = parseTargetList(targetText);
if (urls.length === 0) {
  throw new Error(`No targets found in ${TARGET_FILE}`);
}

const service = new BrowserService(config);
await service.start();

try {
  const discoveries = await pool(urls, DISCOVERY_CONCURRENCY, (url) => discover(service, url));
  const tasks = validationTasks(discoveries);
  const validations = await pool(
    tasks,
    VALIDATION_CONCURRENCY,
    ({ discovery, kind, mode }) => validateThreeOaks(service, discovery, { kind, mode }),
  );

  const publicDiscoveries = discoveries.map((entry) => {
    if (!entry?.start) return entry;
    const { start, ...rest } = entry;
    return rest;
  });

  const report = {
    generated_at: new Date().toISOString(),
    target_file: path.relative(process.cwd(), TARGET_FILE),
    duration_ms: Date.now() - runStarted,
    targets: publicDiscoveries,
    validations,
    summary: {
      total_targets: urls.length,
      discovered: publicDiscoveries.filter((entry) => entry?.ok).length,
      requires_review: publicDiscoveries.filter((entry) => entry?.status === 'REQUIRES_REVIEW').length,
      validation_total: validations.length,
      validation_ok: validations.filter((entry) => entry?.ok).length,
      validation_failed: validations.filter((entry) => !entry?.ok).length,
    },
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIR, 'analysis-report.json'), JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(path.join(OUTPUT_DIR, 'analysis-report.md'), markdown(report), 'utf8');

  console.log(JSON.stringify(report.summary));
} finally {
  await service.stop();
}
