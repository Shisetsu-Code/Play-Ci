import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { parseTargetList } from '../src/target-list.js';
import {
  extractThreeOaksStart,
  summarizeThreeOaksStart,
  buildThreeOaksValidationPlan,
  classifyThreeOaksPlay,
  threeOaksNeedsReview,
  threeOaksReviewReasons,
  buildThreeOaksExecutionBlueprints,
  threeOaksValidationSignature,
} from '../src/providers/three-oaks.js';

const TARGET_FILE = path.resolve(process.env.TARGET_FILE || 'analysis/targets.txt');
const OUTPUT_DIR = path.resolve(process.env.ANALYSIS_OUTPUT_DIR || 'artifacts/analysis');

const DISCOVERY_CONCURRENCY = envInt('ANALYSIS_DISCOVERY_CONCURRENCY', 4, 1, 12);
const VALIDATION_CONCURRENCY = envInt('ANALYSIS_VALIDATION_CONCURRENCY', 2, 1, 4);
const VALIDATION_BATCH_SIZE = envInt('ANALYSIS_VALIDATION_BATCH_SIZE', 5, 1, 10);
const VALIDATION_BATCH_DELAY_MS = envInt('ANALYSIS_VALIDATION_BATCH_DELAY_MS', 2500, 0, 60000);
const VALIDATION_READY_TIMEOUT_MS = envInt('ANALYSIS_VALIDATION_READY_TIMEOUT_MS', 30000, 5000, 90000);
const VALIDATION_ACTIVITY_TIMEOUT_MS = envInt('ANALYSIS_VALIDATION_ACTIVITY_TIMEOUT_MS', 5000, 1000, 20000);
const MAX_PROVIDER_BLOCK_STREAK = envInt('ANALYSIS_MAX_PROVIDER_BLOCK_STREAK', 2, 1, 10);
const RUNTIME_VALIDATION = envBool('ANALYSIS_RUNTIME_VALIDATION', false);
const VALIDATE_ALL_MODES = envBool('ANALYSIS_VALIDATE_ALL_MODES', false);
const VALIDATE_BASE_SPIN = envBool('ANALYSIS_VALIDATE_BASE_SPIN', false);

function envInt(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit, items.length || 1));

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        results[index] = {
          ok: false,
          status: 'ERROR',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

function summarizeGeneric(events) {
  const observed = [];
  for (const event of events) {
    if (event?.type !== 'responsebody' || !event.body) continue;
    let body;
    try { body = JSON.parse(event.body); } catch { continue; }
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

function detectThreeOaksClientFamily(events) {
  for (const event of events) {
    const url = event?.url || '';
    const match = url.match(/\/gs\/clients_([^/]+)\//i);
    if (match) return match[1].toLowerCase();
  }
  return 'unknown';
}

function declaredFeatures(protocol) {
  const rows = [];

  for (const mode of protocol?.available_buy_bonus || []) {
    rows.push({
      kind: 'buy',
      action: 'buy_spin',
      mode,
      multiplier: protocol.buy_bonus_prices?.[String(mode)] ?? null,
      evidence: 'server_start',
      status: 'DECLARED',
    });
  }

  for (const mode of protocol?.available_booster || []) {
    rows.push({
      kind: 'booster',
      action: 'spin',
      mode,
      ante_bet: protocol.booster_prices?.[String(mode)] ?? null,
      multiplier: protocol.booster_prices?.[String(mode)] ?? null,
      evidence: 'server_start',
      status: 'DECLARED',
    });
  }

  return rows;
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
    const start = extractThreeOaksStart(events);

    if (start) {
      const protocol = summarizeThreeOaksStart(start);
      const reviewReasons = threeOaksReviewReasons(protocol);
      return {
        ok: true,
        url,
        provider: '3oaks',
        client_family: detectThreeOaksClientFamily(events),
        status: threeOaksNeedsReview(protocol) ? 'REQUIRES_REVIEW' : 'DISCOVERED',
        duration_ms: Date.now() - started,
        protocol,
        review_reasons: reviewReasons,
        declared_features: declaredFeatures(protocol),
        execution_blueprints: buildThreeOaksExecutionBlueprints(protocol),
      };
    }

    return {
      ok: true,
      url,
      provider: 'unknown',
      client_family: 'unknown',
      status: 'REQUIRES_REVIEW',
      duration_ms: Date.now() - started,
      observed_json: summarizeGeneric(events),
      declared_features: [],
    };
  } finally {
    await service.closeSession(session.id);
  }
}

async function testActionsShape(page) {
  return page.evaluate(() => {
    const raw = window.TestActions;
    if (!raw) return { kind: 'missing', methods: [] };

    if (typeof raw === 'object') {
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(raw))
        .filter((name) => typeof raw[name] === 'function');
      return { kind: 'instance', methods };
    }

    if (typeof raw === 'function') {
      const methods = Object.getOwnPropertyNames(raw)
        .filter((name) => typeof raw[name] === 'function');
      const sources = {};
      for (const name of methods) {
        if (!/buy|shop|spin|start|bonus|option/i.test(name)) continue;
        sources[name] = Function.prototype.toString.call(raw[name]).slice(0, 600);
      }
      return { kind: 'static', methods, sources };
    }

    return { kind: typeof raw, methods: [] };
  });
}

function sourceIsEmptyStub(source) {
  if (!source) return false;
  const compact = source.replace(/\s+/g, '');
  return /\{\}$/.test(compact);
}

async function waitForNativeClient(internal) {
  const network = await internal.recorder.waitForQuiet({
    quietMs: 1200,
    timeoutMs: VALIDATION_READY_TIMEOUT_MS,
  });

  if (!network.quiet) {
    return {
      ready: false,
      reason: 'network_never_quiet',
      network,
    };
  }

  await sleep(600);

  const shape = await testActionsShape(internal.page);
  if (shape.kind === 'missing') {
    return {
      ready: false,
      reason: 'test_actions_missing',
      network,
      shape,
    };
  }

  return {
    ready: true,
    network,
    shape,
  };
}

async function dismissThreeOaksStart(page, shape) {
  try {
    if (shape.kind === 'instance') {
      const closed = await page.evaluate(() => {
        if (typeof window.TestActions?.closeStartScreen === 'function') {
          window.TestActions.closeStartScreen();
          return true;
        }
        return false;
      });
      if (closed) {
        await sleep(1200);
        return 'test_actions';
      }
    }

    if (shape.kind === 'static') {
      const source = shape.sources?.closeStartScreen;
      if (source && !sourceIsEmptyStub(source)) {
        const closed = await page.evaluate(() => {
          if (typeof window.TestActions?.closeStartScreen === 'function') {
            window.TestActions.closeStartScreen();
            return true;
          }
          return false;
        });
        if (closed) {
          await sleep(1200);
          return 'test_actions_static';
        }
      }
    }
  } catch {}

  const viewport = config.viewport;
  await page.mouse.click(viewport.width / 2, viewport.height - 50);
  await sleep(1500);
  return 'viewport_click';
}

async function invokeBuy(page, shape, task) {
  if (shape.kind === 'instance') {
    const supported = shape.methods.includes('playBuyFeature');
    if (!supported) return { invoked: false, reason: 'buy_hook_missing' };

    await page.evaluate(() => {
      if (typeof window.TestActions?.openBuyFeaturePopup === 'function') {
        window.TestActions.openBuyFeaturePopup();
      }
    });
    await sleep(700);

    await page.evaluate((index) => window.TestActions.playBuyFeature(index), task.modeIndex);
    return { invoked: true, hook: 'TestActions.playBuyFeature', modeIndex: task.modeIndex };
  }

  if (shape.kind === 'static') {
    const source = shape.sources?.playBuyFeature;
    if (!shape.methods.includes('playBuyFeature') || sourceIsEmptyStub(source)) {
      return { invoked: false, reason: 'static_buy_hook_stub' };
    }

    await page.evaluate((index) => window.TestActions.playBuyFeature(index), task.modeIndex);
    return { invoked: true, hook: 'TestActions.playBuyFeature(static)', modeIndex: task.modeIndex };
  }

  return { invoked: false, reason: 'buy_hook_unavailable' };
}

async function invokeBooster(page, shape, task) {
  const result = await page.evaluate(({ mode, modeIndex }) => {
    const raw = window.TestActions;
    if (!raw) return { invoked: false, reason: 'test_actions_missing' };

    const object = typeof raw === 'object' ? raw : raw;
    const names = [
      'activateShopOption',
      'selectShopOption',
      'playShopOption',
      'activateBooster',
      'selectBooster',
    ];

    let selected = null;
    for (const name of names) {
      if (typeof object[name] !== 'function') continue;
      try {
        object[name](mode);
        selected = name;
        break;
      } catch {
        try {
          object[name](modeIndex);
          selected = name;
          break;
        } catch {}
      }
    }

    if (!selected) {
      return { invoked: false, reason: 'booster_hook_missing' };
    }

    if (typeof object.spin === 'function') {
      try {
        object.spin();
        return { invoked: true, hook: selected, spinHook: 'spin' };
      } catch (error) {
        return { invoked: false, reason: 'spin_hook_failed', hook: selected, error: error.message };
      }
    }

    return { invoked: false, reason: 'spin_hook_missing', hook: selected };
  }, { mode: task.mode, modeIndex: task.modeIndex });

  return result;
}

async function validateNativeTask(service, discovery, task) {
  const started = Date.now();
  const session = await service.createSession({
    url: discovery.url,
    skipSplash: false,
    captureInitialScreenshot: false,
  });

  try {
    const internal = service.sessions.get(session.id);
    const readiness = await waitForNativeClient(internal);

    if (!readiness.ready) {
      return {
        ok: false,
        url: discovery.url,
        provider: '3oaks',
        client_family: discovery.client_family,
        kind: task.kind,
        mode: task.mode,
        declared_multiplier: task.declaredMultiplier ?? 1,
        status: 'DECLARED_CLIENT_NOT_READY',
        duration_ms: Date.now() - started,
        readiness,
      };
    }

    const startDismissal = await dismissThreeOaksStart(internal.page, readiness.shape);
    const marker = internal.recorder.marker();

    let invocation;
    if (task.kind === 'buy') {
      invocation = await invokeBuy(internal.page, readiness.shape, task);
    } else if (task.kind === 'booster') {
      invocation = await invokeBooster(internal.page, readiness.shape, task);
    } else if (task.kind === 'spin') {
      invocation = await internal.page.evaluate(() => {
        const raw = window.TestActions;
        if (raw && typeof raw.spin === 'function') {
          try {
            raw.spin();
            return { invoked: true, hook: 'TestActions.spin' };
          } catch (error) {
            return { invoked: false, reason: 'spin_hook_failed', error: error.message };
          }
        }
        return { invoked: false, reason: 'spin_hook_missing' };
      });
    } else {
      invocation = { invoked: false, reason: 'unsupported_task' };
    }

    if (!invocation?.invoked) {
      return {
        ok: false,
        url: discovery.url,
        provider: '3oaks',
        client_family: discovery.client_family,
        kind: task.kind,
        mode: task.mode,
        declared_multiplier: task.declaredMultiplier ?? 1,
        status: 'DECLARED_NATIVE_HOOK_UNAVAILABLE',
        duration_ms: Date.now() - started,
        start_dismissal: startDismissal,
        invocation,
      };
    }

    await internal.recorder.waitForActivityAfter(marker, {
      timeoutMs: VALIDATION_ACTIVITY_TIMEOUT_MS,
    });
    await internal.recorder.waitForQuiet({
      quietMs: 800,
      timeoutMs: Math.max(5000, VALIDATION_ACTIVITY_TIMEOUT_MS + 4000),
    });

    let plays = classifyThreeOaksPlay(internal.recorder.eventsAfter(0), marker);

    if (plays.length === 0 && task.kind === 'buy' && readiness.shape.kind === 'instance') {
      try {
        await internal.page.evaluate((index) => window.TestActions.playBuyFeature(index), task.modeIndex);
        await internal.recorder.waitForActivityAfter(marker, {
          timeoutMs: VALIDATION_ACTIVITY_TIMEOUT_MS,
        });
        await internal.recorder.waitForQuiet({
          quietMs: 800,
          timeoutMs: Math.max(5000, VALIDATION_ACTIVITY_TIMEOUT_MS + 4000),
        });
        plays = classifyThreeOaksPlay(internal.recorder.eventsAfter(0), marker);
      } catch {}
    }

    if (plays.length === 0) {
      return {
        ok: false,
        url: discovery.url,
        provider: '3oaks',
        client_family: discovery.client_family,
        kind: task.kind,
        mode: task.mode,
        declared_multiplier: task.declaredMultiplier ?? 1,
        status: 'DECLARED_NATIVE_NO_REQUEST',
        duration_ms: Date.now() - started,
        start_dismissal: startDismissal,
        invocation,
      };
    }

    const play = plays.at(-1);
    const providerBlocked = [403, 429].includes(play.http_status);

    return {
      ok: play.accepted,
      url: discovery.url,
      provider: '3oaks',
      client_family: discovery.client_family,
      kind: task.kind,
      mode: task.mode,
      declared_multiplier: task.declaredMultiplier ?? 1,
      status: providerBlocked
        ? 'DEFERRED_PROVIDER_BLOCK'
        : play.accepted
          ? 'VALIDATED_NATIVE'
          : 'NATIVE_REJECTED',
      duration_ms: Date.now() - started,
      start_dismissal: startDismissal,
      invocation,
      request: play.request,
      response: {
        http_status: play.http_status,
        server_status: play.response?.status ?? null,
        command: play.response?.command ?? null,
        last_action: play.response?.context?.last_action ?? null,
        last_args: play.response?.context?.last_args ?? null,
        next_actions: play.response?.context?.actions ?? null,
        round_finished: play.response?.context?.round_finished ?? null,
        balance: play.response?.user?.balance ?? null,
        currency: play.response?.user?.currency ?? null,
      },
    };
  } finally {
    await service.closeSession(session.id);
  }
}

function validationGroups(discoveries) {
  if (!RUNTIME_VALIDATION) return [];
  const groups = new Map();

  for (const discovery of discoveries) {
    if (!discovery?.ok || discovery.provider !== '3oaks') continue;

    const tasks = buildThreeOaksValidationPlan(discovery, {
      validateBaseSpin: VALIDATE_BASE_SPIN,
      validateAllModes: VALIDATE_ALL_MODES,
    });
    if (tasks.length === 0) continue;

    const signature = threeOaksValidationSignature(discovery);
    const existing = groups.get(signature);
    if (existing) {
      existing.covers_urls.push(discovery.url);
      continue;
    }

    groups.set(signature, {
      signature,
      discovery,
      tasks,
      covers_urls: [discovery.url],
    });
  }

  return [...groups.values()];
}

async function validateGroup(service, group) {
  const results = [];
  for (const task of group.tasks) {
    const result = await validateNativeTask(service, group.discovery, task);
    results.push({
      ...result,
      validation_signature: group.signature,
      representative_url: group.discovery.url,
      covers_urls: group.covers_urls,
    });
  }
  return results;
}

function deferredForGroup(group, reason = 'provider_block_circuit_open') {
  return group.tasks.map((task) => ({
    ok: false,
    url: group.discovery.url,
    provider: '3oaks',
    client_family: group.discovery.client_family,
    kind: task.kind,
    mode: task.mode,
    declared_multiplier: task.declaredMultiplier ?? 1,
    status: 'DEFERRED_PROVIDER_BLOCK',
    reason,
    validation_signature: group.signature,
    representative_url: group.discovery.url,
    covers_urls: group.covers_urls,
  }));
}

async function runAdaptiveValidation(service, groups) {
  const results = [];
  let providerBlockStreak = 0;
  let circuitOpen = false;

  for (let offset = 0; offset < groups.length; offset += VALIDATION_BATCH_SIZE) {
    const batch = groups.slice(offset, offset + VALIDATION_BATCH_SIZE);

    if (circuitOpen) {
      for (const group of batch) results.push(...deferredForGroup(group));
      continue;
    }

    const batchResults = await pool(batch, VALIDATION_CONCURRENCY, (group) => validateGroup(service, group));

    for (const groupResults of batchResults) {
      for (const item of groupResults || []) {
        results.push(item);
        if (item?.status === 'DEFERRED_PROVIDER_BLOCK') {
          providerBlockStreak += 1;
        } else if (item?.status === 'VALIDATED_NATIVE') {
          providerBlockStreak = 0;
        }

        if (providerBlockStreak >= MAX_PROVIDER_BLOCK_STREAK) {
          circuitOpen = true;
        }
      }
    }

    if (circuitOpen) {
      const remaining = groups.slice(offset + VALIDATION_BATCH_SIZE);
      for (const group of remaining) results.push(...deferredForGroup(group));
      break;
    }

    if (offset + VALIDATION_BATCH_SIZE < groups.length && VALIDATION_BATCH_DELAY_MS > 0) {
      await sleep(VALIDATION_BATCH_DELAY_MS);
    }
  }

  return {
    results,
    circuit_open: circuitOpen,
    provider_block_streak: providerBlockStreak,
  };
}

function publicTarget(target) {
  return target;
}

function countDeclared(targets, kind) {
  return targets.reduce(
    (sum, target) => sum + (target.declared_features || []).filter((row) => row.kind === kind).length,
    0,
  );
}

function markdown(report) {
  const lines = [
    '# Play-Ci analysis report',
    '',
    `Generated: ${report.generated_at}`,
    `Targets: ${report.targets.length}`,
    `Duration: ${(report.duration_ms / 1000).toFixed(2)} s`,
    '',
    '## Summary',
    '',
    `- Discovered: ${report.summary.discovered}/${report.summary.total_targets}`,
    `- Requires review: ${report.summary.requires_review}`,
    `- Declared buy modes: ${report.summary.declared_buy_modes}`,
    `- Declared booster modes: ${report.summary.declared_booster_modes}`,
    `- Execution blueprints: ${report.summary.execution_blueprints}`,
    `- Runtime validation enabled: ${report.policy.runtime_validation_enabled}`,
    `- Runtime validations attempted: ${report.summary.runtime_attempted}`,
    `- Runtime validated: ${report.summary.runtime_validated}`,
    `- Runtime unavailable/no request: ${report.summary.runtime_unavailable}`,
    `- Provider-block deferred: ${report.summary.runtime_deferred}`,
    `- Runtime rejected: ${report.summary.runtime_rejected}`,
    `- Validation signatures: ${report.summary.validation_signatures}`,
    `- Targets covered by representative runtime validation: ${report.summary.runtime_covered_targets}`,
    '',
  ];

  for (const target of report.targets) {
    lines.push(`## ${target.url}`, '');
    lines.push(`- Provider: ${target.provider || 'unknown'}`);
    lines.push(`- Client family: ${target.client_family || 'unknown'}`);
    lines.push(`- Status: ${target.status || (target.ok ? 'DISCOVERED' : 'ERROR')}`);
    lines.push(`- Discovery: ${target.duration_ms ?? '?'} ms`);

    if (target.protocol) {
      lines.push(`- Actions: ${JSON.stringify(target.protocol.actions || [])}`);
      lines.push(`- Unhandled actions: ${JSON.stringify(target.protocol.unhandled_actions || [])}`);
      lines.push(`- Buy modes: ${JSON.stringify(target.protocol.available_buy_bonus || [])}`);
      lines.push(`- Buy prices: ${JSON.stringify(target.protocol.buy_bonus_prices || {})}`);
      lines.push(`- Boosters: ${JSON.stringify(target.protocol.available_booster || [])}`);
      lines.push(`- Booster prices: ${JSON.stringify(target.protocol.booster_prices || {})}`);
      lines.push(`- Review reasons: ${JSON.stringify(target.review_reasons || [])}`);
      lines.push(`- Execution blueprints: ${(target.execution_blueprints || []).length}`);
    }

    const validations = report.validations.filter((entry) => entry.url === target.url);
    if (validations.length) {
      lines.push('', 'Runtime validation (representative by default):');
      for (const item of validations) {
        lines.push(
          `- ${item.kind}${item.mode == null ? '' : ` mode ${item.mode}`}: ${item.status}; HTTP ${item.response?.http_status ?? '-'}; multiplier ${item.declared_multiplier ?? '-'}`
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
if (urls.length === 0) throw new Error(`No targets found in ${TARGET_FILE}`);

const service = new BrowserService(config);
await service.start();

try {
  const discoveries = await pool(urls, DISCOVERY_CONCURRENCY, (url) => discover(service, url));
  const groups = validationGroups(discoveries);
  const adaptive = await runAdaptiveValidation(service, groups);
  const validations = adaptive.results;
  const targets = discoveries.map((target) => ({
    ...publicTarget(target),
    validation_signature:
      target?.ok && target.provider === '3oaks'
        ? threeOaksValidationSignature(target)
        : null,
  }));

  const runtimeUnavailableStatuses = new Set([
    'DECLARED_CLIENT_NOT_READY',
    'DECLARED_NATIVE_HOOK_UNAVAILABLE',
    'DECLARED_NATIVE_NO_REQUEST',
  ]);

  const report = {
    generated_at: new Date().toISOString(),
    target_file: path.relative(process.cwd(), TARGET_FILE),
    duration_ms: Date.now() - runStarted,
    policy: {
      discovery_concurrency: DISCOVERY_CONCURRENCY,
      validation_concurrency: VALIDATION_CONCURRENCY,
      validation_batch_size: VALIDATION_BATCH_SIZE,
      validation_batch_delay_ms: VALIDATION_BATCH_DELAY_MS,
      validate_all_modes: VALIDATE_ALL_MODES,
      validate_base_spin: VALIDATE_BASE_SPIN,
      max_provider_block_streak: MAX_PROVIDER_BLOCK_STREAK,
      runtime_validation_enabled: RUNTIME_VALIDATION,
      runtime_validation_role: 'supplemental only; server start declarations are authoritative discovery evidence',
      runtime_validation_scope: RUNTIME_VALIDATION
        ? 'one representative game per client/protocol signature by default'
        : 'disabled by default to avoid UI-hook false negatives and provider rate pressure',
    },
    validation_circuit: {
      open: adaptive.circuit_open,
      provider_block_streak: adaptive.provider_block_streak,
    },
    targets,
    validations,
    summary: {
      total_targets: urls.length,
      discovered: targets.filter((entry) => entry?.ok).length,
      requires_review: targets.filter((entry) => entry?.status === 'REQUIRES_REVIEW').length,
      declared_buy_modes: countDeclared(targets, 'buy'),
      declared_booster_modes: countDeclared(targets, 'booster'),
      execution_blueprints: targets.reduce((sum, target) => sum + (target.execution_blueprints || []).length, 0),
      runtime_attempted: validations.filter((entry) => !entry.reason?.includes('circuit_open')).length,
      runtime_validated: validations.filter((entry) => entry?.status === 'VALIDATED_NATIVE').length,
      runtime_unavailable: validations.filter((entry) => runtimeUnavailableStatuses.has(entry?.status)).length,
      runtime_deferred: validations.filter((entry) => entry?.status === 'DEFERRED_PROVIDER_BLOCK').length,
      runtime_rejected: validations.filter((entry) => entry?.status === 'NATIVE_REJECTED').length,
      validation_signatures: groups.length,
      runtime_covered_targets: new Set(validations.flatMap((entry) => entry?.covers_urls || [])).size,
    },
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIR, 'analysis-report.json'), JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(path.join(OUTPUT_DIR, 'analysis-report.md'), markdown(report), 'utf8');

  const blueprintCatalog = targets
    .filter((target) => target.provider === '3oaks')
    .map((target) => ({
      url: target.url,
      client_family: target.client_family,
      status: target.status,
      review_reasons: target.review_reasons || [],
      protocol: target.protocol,
      execution_blueprints: target.execution_blueprints || [],
    }));
  await fs.writeFile(
    path.join(OUTPUT_DIR, 'protocol-blueprints.json'),
    JSON.stringify(blueprintCatalog, null, 2),
    'utf8',
  );

  const reviewTargets = targets
    .filter((target) => target.status === 'REQUIRES_REVIEW')
    .map((target) => target.url);
  await fs.writeFile(
    path.join(OUTPUT_DIR, 'review-targets.txt'),
    reviewTargets.length ? `${reviewTargets.join('\n')}\n` : '',
    'utf8',
  );

  const retryTargets = [...new Set(
    validations
      .filter((entry) => entry.status === 'DEFERRED_PROVIDER_BLOCK')
      .map((entry) => entry.url)
  )];
  await fs.writeFile(
    path.join(OUTPUT_DIR, 'retry-targets.txt'),
    retryTargets.length ? `${retryTargets.join('\n')}\n` : '',
    'utf8',
  );

  console.log(JSON.stringify(report.summary));
} finally {
  await service.stop();
}
