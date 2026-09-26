import crypto from 'node:crypto';
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
  threeOaksEffectiveBets,
} from '../src/providers/three-oaks.js';
import {
  waitForThreeOaksCapability,
  dismissThreeOaksStart as dismissThreeOaksRuntimeStart,
  invokeThreeOaksTask,
  triggerThreeOaksSpinControl,
} from '../src/providers/three-oaks-runtime.js';
import {
  loadVisualProfiles,
  indexVisualProfiles,
  matchVisualProfile,
  coordinateForBuy,
  coordinateForBooster,
} from '../src/visual-profiles.js';

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
const RUNTIME_MODE = String(process.env.ANALYSIS_RUNTIME_MODE || 'visual').toLowerCase();
const VISUAL_CAPTURE_EVIDENCE = envBool('ANALYSIS_VISUAL_CAPTURE_EVIDENCE', true);
const VALIDATE_ALL_MODES = envBool('ANALYSIS_VALIDATE_ALL_MODES', false);
const VALIDATE_BASE_SPIN = envBool('ANALYSIS_VALIDATE_BASE_SPIN', false);
const VALIDATE_EVERY_TARGET = envBool('ANALYSIS_VALIDATE_EVERY_TARGET', false);

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

  if (
    (protocol?.available_buy_bonus || []).length === 0 &&
    (protocol?.actions || []).includes('buy_spin') &&
    Number.isFinite(Number(protocol?.fixed_buy_multiplier))
  ) {
    rows.push({
      kind: 'buy',
      action: 'buy_spin',
      mode: null,
      fixed: true,
      multiplier: Number(protocol.fixed_buy_multiplier),
      evidence: 'server_start',
      status: 'DECLARED',
    });
  }

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
  const started = Date.now();
  let lastShape = null;

  while (Date.now() - started < VALIDATION_READY_TIMEOUT_MS) {
    const state = await internal.page.evaluate(() => {
      const board = window.app?.board;
      const testActions = window.TestActions;
      return {
        document_ready: document.readyState,
        has_app: Boolean(window.app),
        has_board: Boolean(board),
        has_buy_feature: typeof board?.buyFeature?.actBuyFeature === 'function',
        has_board_spin: typeof board?.spin === 'function',
        has_test_actions: Boolean(testActions),
        has_test_spin: typeof testActions?.spin === 'function',
        has_gr_ui: Boolean(window.GR?.UI),
      };
    }).catch(() => null);

    lastShape = state;
    if (state?.has_board || state?.has_test_actions || state?.has_gr_ui) {
      const shape = await testActionsShape(internal.page).catch(() => ({ kind: 'missing', methods: [] }));
      return {
        ready: true,
        reason: 'client_objects_ready',
        waited_ms: Date.now() - started,
        state,
        shape,
      };
    }

    await sleep(150);
  }

  return {
    ready: false,
    reason: 'client_objects_timeout',
    waited_ms: Date.now() - started,
    state: lastShape,
    shape: { kind: 'missing', methods: [] },
  };
}

async function dismissThreeOaksStart(page, shape) {
  try {
    const result = await page.evaluate(() => {
      const fn = window.TestActions?.closeStartScreen;
      if (typeof fn === 'function') {
        const source = Function.prototype.toString.call(fn).replace(/\s+/g, '');
        if (!/\{\}$/.test(source)) {
          fn.call(window.TestActions);
          return 'TestActions.closeStartScreen';
        }
      }

      const skip = window.app?.startScreen?.skip;
      if (typeof skip === 'function') {
        skip.call(window.app.startScreen);
        return 'app.startScreen.skip';
      }

      return null;
    });

    if (result) {
      await sleep(1200);
      return result;
    }
  } catch {}

  const viewport = config.viewport;
  await page.mouse.click(viewport.width / 2, viewport.height - 50);
  await sleep(1500);
  return 'viewport_click';
}


async function waitForGameplayControls(page, timeoutMs = 6000) {
  const started = Date.now();
  let last = null;

  while (Date.now() - started < timeoutMs) {
    last = await page.evaluate(() => {
      const model = window.GR?.UI?.model;
      let controlsAvailable = null;
      let preloaderHidden = null;
      let actions = null;
      try { controlsAvailable = model?.get?.('controls.available') ?? null; } catch {}
      try { preloaderHidden = model?.get?.('preloader_hidden') ?? null; } catch {}
      try { actions = model?.get?.('actions') ?? null; } catch {}

      return {
        controls_available: controlsAvailable,
        preloader_hidden: preloaderHidden,
        actions,
        has_board: Boolean(window.app?.board),
        has_gr_events: Boolean(window.GR?.UI?.Events),
      };
    }).catch(() => null);

    if (
      last?.has_board &&
      (
        last.controls_available === true ||
        (last.controls_available == null && last.preloader_hidden !== false)
      )
    ) {
      return { ready: true, waited_ms: Date.now() - started, state: last };
    }

    await sleep(150);
  }

  return { ready: false, waited_ms: Date.now() - started, state: last };
}

async function invokeBuy(page, shape, task, clientFamily) {
  return page.evaluate(async ({ mode, modeIndex, clientFamily }) => {
    const ta = window.TestActions;

    try {
      if (clientFamily === 'ratpack') {
        const open = ta?.openBuyFeaturePopup;
        if (typeof open === 'function') {
          const source = Function.prototype.toString.call(open).replace(/\s+/g, '');
          if (!/\{\}$/.test(source)) {
            open.call(ta);
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      } else if (clientFamily === 'kendoo') {
        const clickAccessor = window.GR?.UI?.view?.buy_feature?.click;
        if (typeof clickAccessor === 'function') {
          const handler = clickAccessor();
          if (typeof handler === 'function') {
            handler();
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      }
    } catch {}

    const candidates = [
      ['app.board.buyFeature.actBuyFeature', window.app?.board?.buyFeature],
      ['app.board.buyBonus.actBuyFeature', window.app?.board?.buyBonus],
      ['app.buyBonus.actBuyFeature', window.app?.buyBonus],
    ];

    for (const [name, owner] of candidates) {
      const direct = owner?.actBuyFeature;
      if (typeof direct !== 'function') continue;
      try {
        if (mode == null) direct.call(owner);
        else direct.call(owner, mode);
        return {
          invoked: true,
          hook: name,
          argument: mode,
          fixed: mode == null,
          client_family: clientFamily,
        };
      } catch {}
    }

    if (!ta) return { invoked: false, reason: 'buy_hook_unavailable', client_family: clientFamily };

    try {
      if (typeof ta.playBuyFeature === 'function') {
        if (mode == null) ta.playBuyFeature();
        else ta.playBuyFeature(mode);
        return {
          invoked: true,
          hook: 'TestActions.playBuyFeature',
          argument: mode,
          fixed: mode == null,
          client_family: clientFamily,
        };
      }
    } catch (error) {
      if (modeIndex != null) {
        try {
          ta.playBuyFeature(modeIndex);
          return {
            invoked: true,
            hook: 'TestActions.playBuyFeature(index-fallback)',
            argument: modeIndex,
            client_family: clientFamily,
          };
        } catch (fallbackError) {
          return {
            invoked: false,
            reason: 'buy_hook_failed',
            error: `${error.message}; fallback: ${fallbackError.message}`,
            client_family: clientFamily,
          };
        }
      }
      return {
        invoked: false,
        reason: 'buy_hook_failed',
        error: error.message,
        client_family: clientFamily,
      };
    }

    return { invoked: false, reason: 'buy_hook_unavailable', client_family: clientFamily };
  }, { mode: task.mode, modeIndex: task.modeIndex, clientFamily });
}

async function invokeBooster(page, shape, task) {
  return page.evaluate(async ({ mode, modeIndex }) => {
    const ta = window.TestActions;
    const popup = window.app?.board?.bonusShopPopup;

    try {
      if (typeof ta?.openBonusShopPopup === 'function') {
        const source = Function.prototype.toString.call(ta.openBonusShopPopup).replace(/\s+/g, '');
        if (!/\{\}$/.test(source)) {
          ta.openBonusShopPopup();
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      } else {
        const shopClick = window.GR?.UI?.view?.shop_button?.click?.();
        if (typeof shopClick === 'function') {
          shopClick();
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      }
    } catch {}

    try {
      if (typeof popup?.activateShopOption === 'function') {
        popup.activateShopOption(mode);
      } else if (typeof ta?.activateShopOption === 'function') {
        ta.activateShopOption(mode);
      } else {
        return { invoked: false, reason: 'booster_selector_missing' };
      }
    } catch (error) {
      try {
        if (typeof popup?.activateShopOption === 'function') popup.activateShopOption(modeIndex);
        else if (typeof ta?.activateShopOption === 'function') ta.activateShopOption(modeIndex);
      } catch (fallbackError) {
        return {
          invoked: false,
          reason: 'booster_selector_failed',
          error: `${error.message}; fallback: ${fallbackError.message}`,
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 120));

    try {
      if (typeof window.GR?.UI?.Events?.spin === 'function') {
        window.GR.UI.Events.spin();
        return {
          invoked: true,
          hook: 'bonusShopPopup.activateShopOption + GR.UI.Events.spin',
          argument: mode,
        };
      }
      if (typeof window.app?.board?.spin === 'function') {
        window.app.board.spin();
        return {
          invoked: true,
          hook: 'bonusShopPopup.activateShopOption + app.board.spin',
          argument: mode,
        };
      }
      if (typeof ta?.spin === 'function') {
        ta.spin();
        return {
          invoked: true,
          hook: 'bonusShopPopup.activateShopOption + TestActions.spin',
          argument: mode,
        };
      }
    } catch (error) {
      return { invoked: false, reason: 'spin_hook_failed', error: error.message };
    }

    return { invoked: false, reason: 'spin_hook_missing' };
  }, { mode: task.mode, modeIndex: task.modeIndex });
}


function validationMatchesTask(play, task) {
  const action = play?.request?.action;
  const params = action?.params || {};

  if (task.kind === 'buy') {
    if (action?.name !== 'buy_spin') return false;

    // Some clients encode a selected buy mode in a provider-specific field
    // (for example buy_spin_scatters_count) or omit selected_mode entirely
    // for a single/fixed purchase. The request was captured causally after
    // invoking exactly this task in a fresh session, so any accepted buy_spin
    // is valid evidence unless it explicitly echoes a conflicting mode.
    if (params.selected_mode != null && task.mode != null) {
      return String(params.selected_mode) === String(task.mode);
    }
    if (params.selected_mode != null && task.mode == null) {
      return false;
    }
    return true;
  }

  if (task.kind === 'booster') {
    if (action?.name !== 'spin') return false;
    return (
      String(params.selected_mode) === String(task.mode) &&
      Number(params.ante_bet) === Number(task.declaredMultiplier)
    );
  }

  if (task.kind === 'spin') {
    return action?.name === 'spin' && params.ante_bet == null;
  }

  return false;
}

function selectTaskPlay(plays, task) {
  if (!plays.length) return null;

  const exact = plays.find((play) => validationMatchesTask(play, task));
  if (exact) return exact;

  if (task.kind === 'buy') {
    const buy = plays.find((play) => play?.request?.action?.name === 'buy_spin');
    if (buy) return buy;
  }

  if (task.kind === 'booster') {
    const spin = plays.find((play) => {
      const params = play?.request?.action?.params || {};
      return (
        play?.request?.action?.name === 'spin' &&
        (params.ante_bet != null || params.selected_mode != null)
      );
    });
    if (spin) return spin;
  }

  if (task.kind === 'spin') {
    const spin = plays.find((play) => play?.request?.action?.name === 'spin');
    if (spin) return spin;
  }

  return plays[0];
}


let visualProfileIndexPromise = null;
const visualEvidenceCaptured = new Set();

async function getVisualProfile(discovery) {
  if (!visualProfileIndexPromise) {
    visualProfileIndexPromise = loadVisualProfiles()
      .then((raw) => indexVisualProfiles(raw));
  }
  const index = await visualProfileIndexPromise;
  return matchVisualProfile(index, discovery);
}

function profilePointSequence(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.clicks)) return entry.clicks;
  if (Number.isFinite(Number(entry.x)) && Number.isFinite(Number(entry.y))) {
    return [{
      x: Number(entry.x),
      y: Number(entry.y),
      waitAfterMs: Number(entry.waitAfterMs || 0),
    }];
  }
  return [];
}

async function clickProfileSequence(page, entry, defaultWaitMs = 0) {
  const points = profilePointSequence(entry);
  for (const point of points) {
    await page.mouse.click(Number(point.x), Number(point.y));
    const waitMs = Number(point.waitAfterMs ?? defaultWaitMs);
    if (waitMs > 0) await sleep(waitMs);
  }
  return points;
}

async function captureVisualEvidence(service, sessionId, discovery, profile) {
  if (!VISUAL_CAPTURE_EVIDENCE || visualEvidenceCaptured.has(discovery.url)) return null;
  visualEvidenceCaptured.add(discovery.url);

  const screenshot = await service.capture(sessionId, 'visual-profile-popup');
  const dir = path.join(OUTPUT_DIR, 'visual-evidence', gameSlug(discovery.url));
  await fs.mkdir(dir, { recursive: true });
  const destination = path.join(dir, `${profile.id}-popup.png`);
  await fs.copyFile(path.resolve(screenshot.path), destination);
  return path.relative(process.cwd(), destination);
}

async function validateVisualTask(service, discovery, task) {
  const started = Date.now();
  const profile = await getVisualProfile(discovery);

  if (!profile) {
    return {
      ok: false,
      url: discovery.url,
      provider: '3oaks',
      client_family: discovery.client_family,
      kind: task.kind,
      mode: task.mode,
      declared_multiplier: task.declaredMultiplier ?? 1,
      status: 'VISUAL_PROFILE_MISSING',
      duration_ms: Date.now() - started,
    };
  }

  const option = task.kind === 'buy'
    ? coordinateForBuy(profile, task.modeIndex ?? 0)
    : task.kind === 'booster'
      ? coordinateForBooster(profile, task.modeIndex ?? 0)
      : profile.spin;

  const requiresBuyOpen = task.kind === 'buy';
  const hasBoosterPath = task.kind !== 'booster' ||
    profile.open_booster === false ||
    Boolean(profile.open_booster || profile.open_economic);

  if (
    !option ||
    !profile.dismiss ||
    (requiresBuyOpen && !profile.open_economic) ||
    !hasBoosterPath
  ) {
    return {
      ok: false,
      url: discovery.url,
      provider: '3oaks',
      client_family: discovery.client_family,
      kind: task.kind,
      mode: task.mode,
      declared_multiplier: task.declaredMultiplier ?? 1,
      status: 'VISUAL_PROFILE_INCOMPLETE',
      visual_profile: profile.id,
      duration_ms: Date.now() - started,
    };
  }

  const session = await service.createSession({
    url: discovery.url,
    skipSplash: false,
    captureInitialScreenshot: false,
  });

  try {
    const internal = service.sessions.get(session.id);
    const waits = profile.waits || {};

    if (Number(waits.initial_ms) > 0) await sleep(Number(waits.initial_ms));
    await clickProfileSequence(internal.page, profile.dismiss, Number(waits.after_dismiss_ms || 0));

    if (task.kind === 'buy') {
      await clickProfileSequence(
        internal.page,
        profile.open_economic,
        Number(waits.after_open_ms || 0),
      );
    } else if (task.kind === 'booster') {
      const boosterOpen = profile.open_booster === false
        ? null
        : (profile.open_booster || profile.open_economic);
      if (boosterOpen) {
        await clickProfileSequence(
          internal.page,
          boosterOpen,
          Number(waits.after_booster_open_ms ?? waits.after_open_ms ?? 0),
        );
      }
    }

    const evidenceScreenshot = task.kind !== 'spin'
      ? await captureVisualEvidence(service, session.id, discovery, profile)
      : null;

    const marker = internal.recorder.marker();
    let clickEvidence = null;

    if (task.kind === 'buy') {
      clickEvidence = await clickProfileSequence(
        internal.page,
        option,
        Number(waits.after_option_ms || 0),
      );
    } else if (task.kind === 'booster') {
      const selectClicks = await clickProfileSequence(
        internal.page,
        option,
        Number(waits.after_booster_select_ms || 0),
      );
      const spinClicks = await clickProfileSequence(
        internal.page,
        profile.spin,
        Number(waits.after_spin_ms || 0),
      );
      clickEvidence = { select: selectClicks, spin: spinClicks };
    } else {
      clickEvidence = await clickProfileSequence(
        internal.page,
        profile.spin,
        Number(waits.after_spin_ms || waits.after_option_ms || 0),
      );
    }

    await internal.recorder.waitForActivityAfter(marker, {
      timeoutMs: VALIDATION_ACTIVITY_TIMEOUT_MS,
    });
    await internal.recorder.waitForQuiet({
      quietMs: 500,
      timeoutMs: Math.max(5000, VALIDATION_ACTIVITY_TIMEOUT_MS + 3000),
    });

    const plays = classifyThreeOaksPlay(internal.recorder.eventsAfter(0), marker);
    if (plays.length === 0) {
      const failureShot = VISUAL_CAPTURE_EVIDENCE
        ? await service.capture(session.id, 'visual-no-request').catch(() => null)
        : null;
      let failureScreenshot = null;
      if (failureShot?.path) {
        const dir = path.join(OUTPUT_DIR, 'visual-evidence', gameSlug(discovery.url));
        await fs.mkdir(dir, { recursive: true });
        const destination = path.join(
          dir,
          `${profile.id}-${task.kind}-${task.mode ?? 'fixed'}-no-request.png`,
        );
        await fs.copyFile(path.resolve(failureShot.path), destination);
        failureScreenshot = path.relative(process.cwd(), destination);
      }

      return {
        ok: false,
        url: discovery.url,
        provider: '3oaks',
        client_family: discovery.client_family,
        kind: task.kind,
        mode: task.mode,
        declared_multiplier: task.declaredMultiplier ?? 1,
        status: 'VISUAL_NO_REQUEST',
        visual_profile: profile.id,
        visual_clicks: clickEvidence,
        visual_evidence: evidenceScreenshot,
        failure_screenshot: failureScreenshot,
        duration_ms: Date.now() - started,
      };
    }

    const play = selectTaskPlay(plays, task);
    const providerBlocked = [403, 429].includes(play.http_status);
    const semanticMatch = validationMatchesTask(play, task);
    const serverCode = play.response?.status?.code ?? null;
    const recognizedButNotExecutable =
      semanticMatch &&
      ['FUNDS_EXCEED', 'SERVER_ERROR'].includes(serverCode);

    return {
      ok: semanticMatch && (play.accepted || recognizedButNotExecutable),
      url: discovery.url,
      provider: '3oaks',
      client_family: discovery.client_family,
      kind: task.kind,
      mode: task.mode,
      declared_multiplier: task.declaredMultiplier ?? 1,
      status: providerBlocked
        ? 'DEFERRED_PROVIDER_BLOCK'
        : semanticMatch && play.accepted
          ? 'VALIDATED_VISUAL'
          : recognizedButNotExecutable
            ? 'VALIDATED_REQUEST_RECOGNIZED'
            : play.accepted
              ? 'VISUAL_MODE_MISMATCH'
              : 'VISUAL_REJECTED',
      duration_ms: Date.now() - started,
      visual_profile: profile.id,
      visual_clicks: clickEvidence,
      visual_evidence: evidenceScreenshot,
      request: play.request,
      semantic_match: semanticMatch,
      request_recognized: recognizedButNotExecutable,
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

async function validateNativeTask(service, discovery, task) {
  const started = Date.now();
  const session = await service.createSession({
    url: discovery.url,
    skipSplash: false,
    captureInitialScreenshot: false,
  });

  try {
    const internal = service.sessions.get(session.id);

    // Some clients do not instantiate their economic/spin controllers until a
    // real start gesture has dismissed the canvas start screen. Dismiss first,
    // then wait for the specific capability required by this task.
    await internal.page.waitForTimeout(500);
    const startDismissal = await dismissThreeOaksRuntimeStart(internal.page, config.viewport);
    const readiness = await waitForThreeOaksCapability(internal.page, task, {
      timeoutMs: VALIDATION_READY_TIMEOUT_MS,
    });

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
        start_dismissal: startDismissal,
        readiness,
      };
    }

    const gameplay = {
      ready: readiness.ready,
      waited_ms: readiness.waitedMs,
      capabilities: readiness.capabilities,
    };
    const marker = internal.recorder.marker();
    const invocation = await invokeThreeOaksTask(internal.page, task, {
      clientFamily: discovery.client_family,
    });

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
        gameplay,
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
    let fallback_spin = null;

    if (plays.length === 0 && task.kind === 'booster') {
      fallback_spin = await triggerThreeOaksSpinControl(internal.page, config.viewport);

      await internal.recorder.waitForActivityAfter(marker, {
        timeoutMs: VALIDATION_ACTIVITY_TIMEOUT_MS,
      });
      await internal.recorder.waitForQuiet({
        quietMs: 600,
        timeoutMs: Math.max(5000, VALIDATION_ACTIVITY_TIMEOUT_MS + 3000),
      });

      plays = classifyThreeOaksPlay(internal.recorder.eventsAfter(0), marker);
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
        fallback_spin,
      };
    }

    const play = selectTaskPlay(plays, task);
    const providerBlocked = [403, 429].includes(play.http_status);
    const semanticMatch = validationMatchesTask(play, task);
    const serverCode = play.response?.status?.code ?? null;
    const recognizedButNotExecutable =
      semanticMatch &&
      ['FUNDS_EXCEED'].includes(serverCode);

    return {
      ok: semanticMatch && (play.accepted || recognizedButNotExecutable),
      url: discovery.url,
      provider: '3oaks',
      client_family: discovery.client_family,
      kind: task.kind,
      mode: task.mode,
      declared_multiplier: task.declaredMultiplier ?? 1,
      status: providerBlocked
        ? 'DEFERRED_PROVIDER_BLOCK'
        : semanticMatch && play.accepted
          ? 'VALIDATED_NATIVE'
          : recognizedButNotExecutable
            ? 'VALIDATED_REQUEST_RECOGNIZED'
            : play.accepted
              ? 'NATIVE_MODE_MISMATCH'
              : 'NATIVE_REJECTED',
      duration_ms: Date.now() - started,
      start_dismissal: startDismissal,
      gameplay,
      invocation,
      fallback_spin,
      request: play.request,
      semantic_match: semanticMatch,
      request_recognized: recognizedButNotExecutable,
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


async function validateProtocolReplayTask(service, discovery, task) {
  const started = Date.now();
  const session = await service.createSession({
    url: discovery.url,
    skipSplash: false,
    captureInitialScreenshot: false,
  });

  try {
    const internal = service.sessions.get(session.id);
    const start = extractThreeOaksStart(internal.recorder.eventsAfter(0));
    if (!start?.body?.session_id || !start?.request?.url) {
      return {
        ok: false,
        url: discovery.url,
        provider: '3oaks',
        client_family: discovery.client_family,
        kind: task.kind,
        mode: task.mode,
        declared_multiplier: task.declaredMultiplier ?? 1,
        status: 'PROTOCOL_REPLAY_START_MISSING',
        duration_ms: Date.now() - started,
      };
    }

    const playUrl = new URL(start.request.url);
    playUrl.searchParams.set('gsc', 'play');

    const context = start.body.context || {};
    const settings = start.body.settings || {};
    const params = {
      bet_per_line: context.spins?.bet_per_line,
      lines: context.spins?.lines,
    };

    const factors = Array.isArray(settings.bet_factor)
      ? settings.bet_factor
      : [settings.bet_factor];
    const firstFactor = factors.map(Number).find(Number.isFinite);
    if (
      Number.isFinite(firstFactor) &&
      ['goreel', 'hraymo', 'enjoy'].includes(discovery.client_family)
    ) {
      params.bet_factor = firstFactor;
    }

    if (task.kind === 'buy' && task.mode != null) {
      params.selected_mode = task.mode;
    } else if (task.kind === 'booster') {
      params.selected_mode = task.mode;
      params.ante_bet = Number(task.declaredMultiplier);
    }

    const payload = {
      command: 'play',
      request_id: crypto.randomUUID().replaceAll('-', ''),
      session_id: start.body.session_id,
      action: {
        name: task.kind === 'buy' ? 'buy_spin' : 'spin',
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

    const response = await internal.context.request.post(playUrl.toString(), {
      headers: {
        'content-type': 'text/plain',
        referer: 'https://3oaks.com/',
      },
      data: JSON.stringify(payload),
      failOnStatusCode: false,
    });

    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}

    const httpStatus = response.status();
    const serverCode = body?.status?.code ?? null;
    const providerBlocked = [403, 429].includes(httpStatus);
    const recognized =
      httpStatus >= 200 &&
      httpStatus < 300 &&
      ['OK', 'FUNDS_EXCEED', 'SERVER_ERROR'].includes(serverCode);

    return {
      ok: recognized,
      url: discovery.url,
      provider: '3oaks',
      client_family: discovery.client_family,
      kind: task.kind,
      mode: task.mode,
      declared_multiplier: task.declaredMultiplier ?? 1,
      status: providerBlocked
        ? 'DEFERRED_PROVIDER_BLOCK'
        : serverCode === 'OK'
          ? 'VALIDATED_PROTOCOL_REPLAY'
          : recognized
            ? 'VALIDATED_REPLAY_RECOGNIZED'
            : 'PROTOCOL_REPLAY_REJECTED',
      duration_ms: Date.now() - started,
      request: payload,
      response: {
        http_status: httpStatus,
        server_status: body?.status ?? null,
        command: body?.command ?? null,
        last_action: body?.context?.last_action ?? null,
        last_args: body?.context?.last_args ?? null,
        next_actions: body?.context?.actions ?? null,
        round_finished: body?.context?.round_finished ?? null,
        balance: body?.user?.balance ?? null,
        currency: body?.user?.currency ?? null,
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

    const baseSignature = threeOaksValidationSignature(discovery);
    const signature = VALIDATE_EVERY_TARGET
      ? `${baseSignature}|url=${discovery.url}`
      : baseSignature;
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

async function validateHybridTask(service, discovery, task) {
  if (discovery.client_family === 'kendoo') {
    const visual = await validateVisualTask(service, discovery, task);
    if (
      ['VALIDATED_VISUAL', 'VALIDATED_REQUEST_RECOGNIZED', 'DEFERRED_PROVIDER_BLOCK']
        .includes(visual.status)
    ) {
      return visual;
    }

    const replay = await validateProtocolReplayTask(service, discovery, task);
    return replay.ok ? {
      ...replay,
      fallback_from_visual_status: visual.status,
    } : {
      ...visual,
      fallback_replay_status: replay.status,
      fallback_replay: replay,
    };
  }

  const native = await validateNativeTask(service, discovery, task);
  if (
    ['VALIDATED_NATIVE', 'VALIDATED_REQUEST_RECOGNIZED', 'DEFERRED_PROVIDER_BLOCK']
      .includes(native.status)
  ) {
    return native;
  }

  const visual = await validateVisualTask(service, discovery, task);
  if (
    ['VALIDATED_VISUAL', 'VALIDATED_REQUEST_RECOGNIZED', 'DEFERRED_PROVIDER_BLOCK']
      .includes(visual.status)
  ) {
    return {
      ...visual,
      fallback_from_native_status: native.status,
    };
  }

  const replay = await validateProtocolReplayTask(service, discovery, task);
  return replay.ok ? {
    ...replay,
    fallback_from_native_status: native.status,
    fallback_visual_status: visual.status,
  } : {
    ...native,
    fallback_visual_status: visual.status,
    fallback_replay_status: replay.status,
    fallback_replay: replay,
  };
}

async function validateGroup(service, group) {
  const results = [];
  for (const task of group.tasks) {
    const result = RUNTIME_MODE === 'visual'
      ? await validateVisualTask(service, group.discovery, task)
      : RUNTIME_MODE === 'hybrid'
        ? await validateHybridTask(service, group.discovery, task)
        : await validateNativeTask(service, group.discovery, task);
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


function gameSlug(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/games\/([^/]+)\//);
    return match?.[1] || parsed.pathname;
  } catch {
    return url;
  }
}

function buildBetCatalog(targets) {
  return targets.map((target) => {
    const protocol = target.protocol || {};
    const effective = target.provider === '3oaks'
      ? threeOaksEffectiveBets(protocol)
      : {
          raw_bets: [],
          factors: [],
          lines: [],
          denominator: null,
          display_bets: [],
          by_factor: [],
        };

    return {
      game: gameSlug(target.url),
      url: target.url,
      provider: target.provider || 'unknown',
      client_family: target.client_family || 'unknown',
      discovery_status: target.status || (target.ok ? 'DISCOVERED' : 'ERROR'),
      actions: protocol.actions || [],
      unhandled_actions: protocol.unhandled_actions || [],
      raw_bets: effective.raw_bets,
      bet_factors: effective.factors,
      lines: effective.lines,
      denominator: effective.denominator,
      display_bets: effective.display_bets,
      bets_by_factor: effective.by_factor,
      buy_modes: [
        ...(
          (protocol.available_buy_bonus || []).length === 0 &&
          (protocol.actions || []).includes('buy_spin') &&
          Number.isFinite(Number(protocol.fixed_buy_multiplier))
            ? [{
                mode: null,
                fixed: true,
                multiplier: Number(protocol.fixed_buy_multiplier),
                action: 'buy_spin',
                evidence: 'server_start',
              }]
            : []
        ),
        ...(protocol.available_buy_bonus || []).map((mode) => ({
          mode,
          fixed: false,
          multiplier: protocol.buy_bonus_prices?.[String(mode)] ?? null,
          action: 'buy_spin',
          evidence: 'server_start',
        })),
      ],
      boosters: (protocol.available_booster || []).map((mode) => ({
        mode,
        multiplier: protocol.booster_prices?.[String(mode)] ?? null,
        action: 'spin',
        ante_bet: protocol.booster_prices?.[String(mode)] ?? null,
        evidence: 'server_start',
      })),
      catalog_status:
        target.provider === '3oaks' && target.ok && target.status === 'DISCOVERED'
          ? 'COMPLETE'
          : 'REQUIRES_REVIEW',
    };
  });
}

function csvCell(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `"${String(text ?? '').replaceAll('"', '""')}"`;
}

function catalogCsv(catalog) {
  const columns = [
    'game',
    'url',
    'provider',
    'client_family',
    'catalog_status',
    'actions',
    'unhandled_actions',
    'raw_bets',
    'bet_factors',
    'lines',
    'denominator',
    'display_bets',
    'buy_modes',
    'boosters',
  ];

  const rows = [columns.map(csvCell).join(',')];
  for (const game of catalog) {
    rows.push(columns.map((column) => csvCell(game[column])).join(','));
  }
  return `${rows.join('\n')}\n`;
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
    `- Bet catalogs complete: ${report.summary.catalog_complete}/${report.summary.total_targets}`,
    `- Catalogs requiring review: ${report.summary.catalog_requires_review}`,
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
    'VISUAL_PROFILE_MISSING',
    'VISUAL_PROFILE_INCOMPLETE',
    'VISUAL_NO_REQUEST',
  ]);

  const catalog = buildBetCatalog(targets);

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
      validate_every_target: VALIDATE_EVERY_TARGET,
      max_provider_block_streak: MAX_PROVIDER_BLOCK_STREAK,
      runtime_validation_enabled: RUNTIME_VALIDATION,
      runtime_mode: RUNTIME_MODE,
      runtime_validation_role: 'supplemental only; server start declarations are authoritative discovery evidence',
      runtime_validation_scope: RUNTIME_VALIDATION
        ? (VALIDATE_EVERY_TARGET
            ? 'every target independently'
            : 'one representative game per client/protocol signature by default')
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
      runtime_validated: validations.filter((entry) =>
        ['VALIDATED_NATIVE', 'VALIDATED_VISUAL', 'VALIDATED_REQUEST_RECOGNIZED', 'VALIDATED_PROTOCOL_REPLAY', 'VALIDATED_REPLAY_RECOGNIZED'].includes(entry?.status)
      ).length,
      runtime_unavailable: validations.filter((entry) => runtimeUnavailableStatuses.has(entry?.status)).length,
      runtime_deferred: validations.filter((entry) => entry?.status === 'DEFERRED_PROVIDER_BLOCK').length,
      runtime_rejected: validations.filter((entry) => entry?.status === 'NATIVE_REJECTED').length,
      validation_signatures: groups.length,
      runtime_covered_targets: new Set(validations.flatMap((entry) => entry?.covers_urls || [])).size,
      catalog_complete: catalog.filter((entry) => entry.catalog_status === 'COMPLETE').length,
      catalog_requires_review: catalog.filter((entry) => entry.catalog_status !== 'COMPLETE').length,
    },
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIR, 'analysis-report.json'), JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(path.join(OUTPUT_DIR, 'analysis-report.md'), markdown(report), 'utf8');
  await fs.writeFile(path.join(OUTPUT_DIR, 'bet-catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');
  await fs.writeFile(path.join(OUTPUT_DIR, 'bet-catalog.csv'), catalogCsv(catalog), 'utf8');

  const unfinishedTargets = catalog
    .filter((entry) => entry.catalog_status !== 'COMPLETE')
    .map((entry) => entry.url);
  await fs.writeFile(
    path.join(OUTPUT_DIR, 'unfinished-targets.txt'),
    unfinishedTargets.length ? `${unfinishedTargets.join('\n')}\n` : '',
    'utf8',
  );

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
