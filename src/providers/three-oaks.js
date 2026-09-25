const RECOGNIZED_ACTIONS = new Set(['spin', 'buy_spin']);

export function jsonEventBody(event) {
  if (event?.type !== 'responsebody' || !event.body) return null;
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

export function extractThreeOaksStart(events) {
  for (const event of events) {
    const body = jsonEventBody(event);
    if (body?.command !== 'start' || !body?.context || !body?.settings) continue;

    const request = events.find((candidate) =>
      candidate.type === 'request' &&
      candidate.requestId === event.requestId
    );

    return {
      body,
      request: request
        ? {
            method: request.method,
            url: request.url,
            headers: request.headers || {},
            postData: request.postData ?? null,
          }
        : null,
    };
  }
  return null;
}

function firstFinite(value) {
  if (Array.isArray(value)) {
    const found = value.find((entry) => Number.isFinite(Number(entry)));
    return found == null ? null : Number(found);
  }
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function summarizeThreeOaksStart(start) {
  const body = start.body;
  const context = body.context || {};
  const settings = body.settings || {};
  const denominator = Number(settings.currency_format?.denominator || 1);
  const betFactor = firstFinite(settings.bet_factor);
  const betPerLine = Number(context.spins?.bet_per_line ?? context.last_args?.bet_per_line ?? 0);
  const actions = Array.isArray(context.actions) ? context.actions : [];
  const buys = Array.isArray(context.available_buy_bonus) ? context.available_buy_bonus : [];
  const boosters = Array.isArray(context.available_booster) ? context.available_booster : [];

  return {
    provider: '3oaks',
    session_id_present: Boolean(body.session_id),
    actions,
    unhandled_actions: actions.filter((action) => !RECOGNIZED_ACTIONS.has(action)),
    available_buy_bonus: buys,
    available_booster: boosters,
    buy_bonus_prices: settings.buy_bonus_prices || {},
    booster_prices: settings.booster_prices || {},
    bets: settings.bets || [],
    bet_factor: settings.bet_factor ?? null,
    lines: settings.lines || [],
    denominator,
    initial_bet_per_line: context.spins?.bet_per_line ?? null,
    initial_lines: context.spins?.lines ?? null,
    display_bet: betFactor && denominator ? (betPerLine * betFactor) / denominator : null,
  };
}


function roundBetValue(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e8) / 1e8;
}

export function threeOaksEffectiveBets(protocol) {
  const rawBets = Array.isArray(protocol?.bets) ? protocol.bets.map(Number).filter(Number.isFinite) : [];
  const rawFactors = Array.isArray(protocol?.bet_factor)
    ? protocol.bet_factor
    : protocol?.bet_factor == null
      ? []
      : [protocol.bet_factor];
  const factors = rawFactors.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  const denominator = Number(protocol?.denominator || 1);
  const lines = Array.isArray(protocol?.lines) ? protocol.lines : [];

  if (!rawBets.length || !factors.length || !Number.isFinite(denominator) || denominator <= 0) {
    return {
      raw_bets: rawBets,
      factors,
      lines,
      denominator,
      display_bets: [],
      by_factor: [],
    };
  }

  const byFactor = factors.map((factor, index) => ({
    factor,
    lines: lines[index] ?? null,
    display_bets: [...new Set(
      rawBets.map((bet) => roundBetValue((bet * factor) / denominator))
    )].sort((a, b) => a - b),
  }));

  const displayBets = [...new Set(
    byFactor.flatMap((entry) => entry.display_bets)
  )].sort((a, b) => a - b);

  return {
    raw_bets: rawBets,
    factors,
    lines,
    denominator,
    display_bets: displayBets,
    by_factor: byFactor,
  };
}

export function buildThreeOaksValidationPlan(discovery, {
  validateBaseSpin = false,
  validateAllModes = false,
} = {}) {
  const protocol = discovery?.protocol || {};
  const tasks = [];

  if (validateBaseSpin && (protocol.actions || []).includes('spin')) {
    tasks.push({ kind: 'spin', mode: null, modeIndex: null });
  }

  const buys = protocol.available_buy_bonus || [];
  if (buys.length) {
    const selected = validateAllModes ? buys : [buys[0]];
    for (const mode of selected) {
      tasks.push({
        kind: 'buy',
        mode,
        modeIndex: buys.indexOf(mode),
        declaredMultiplier: protocol.buy_bonus_prices?.[String(mode)] ?? null,
      });
    }
  }

  const boosters = protocol.available_booster || [];
  if (boosters.length) {
    const selected = validateAllModes ? boosters : [boosters[0]];
    for (const mode of selected) {
      tasks.push({
        kind: 'booster',
        mode,
        modeIndex: boosters.indexOf(mode),
        declaredMultiplier: protocol.booster_prices?.[String(mode)] ?? null,
      });
    }
  }

  return tasks;
}

export function classifyThreeOaksPlay(events, marker = 0) {
  const scoped = events.filter((event) => event.seq > marker);
  const requests = scoped.filter((event) =>
    event.type === 'request' &&
    event.method === 'POST' &&
    (event.url || '').includes('gsc=play')
  );

  return requests.map((request) => {
    const response = scoped.find((event) =>
      event.type === 'response' &&
      event.requestId === request.requestId
    );
    const bodyEvent = scoped.find((event) =>
      event.type === 'responsebody' &&
      event.requestId === request.requestId
    );

    let requestBody = null;
    let responseBody = null;
    try { requestBody = JSON.parse(request.postData || 'null'); } catch {}
    try { responseBody = JSON.parse(bodyEvent?.body || 'null'); } catch {}

    return {
      requestId: request.requestId,
      request: requestBody ?? request.postData ?? null,
      http_status: response?.status ?? null,
      response: responseBody,
      accepted:
        Number(response?.status) >= 200 &&
        Number(response?.status) < 300 &&
        responseBody?.status?.code === 'OK',
    };
  });
}

export function threeOaksReviewReasons(protocol) {
  const reasons = [];
  const actions = protocol?.actions || [];
  const buys = protocol?.available_buy_bonus || [];
  const boosters = protocol?.available_booster || [];
  const buyPrices = protocol?.buy_bonus_prices || {};
  const boosterPrices = protocol?.booster_prices || {};

  for (const action of protocol?.unhandled_actions || []) {
    reasons.push({ code: 'UNHANDLED_ACTION', action });
  }

  if (actions.includes('buy_spin') && buys.length === 0) {
    reasons.push({ code: 'BUY_ACTION_WITHOUT_DECLARED_MODES' });
  }

  if (buys.length > 0 && !actions.includes('buy_spin')) {
    reasons.push({ code: 'BUY_MODES_WITHOUT_BUY_ACTION' });
  }

  for (const mode of buys) {
    if (buyPrices[String(mode)] == null) {
      reasons.push({ code: 'BUY_MODE_PRICE_UNDECLARED', mode });
    }
  }

  for (const mode of boosters) {
    const anteBet = Number(boosterPrices[String(mode)]);
    if (!Number.isFinite(anteBet)) {
      reasons.push({ code: 'BOOSTER_ANTE_BET_UNDECLARED', mode });
    }
  }

  return reasons;
}

export function threeOaksNeedsReview(protocol) {
  return threeOaksReviewReasons(protocol).some((reason) =>
    ['UNHANDLED_ACTION', 'BUY_ACTION_WITHOUT_DECLARED_MODES', 'BUY_MODES_WITHOUT_BUY_ACTION', 'BOOSTER_ANTE_BET_UNDECLARED']
      .includes(reason.code)
  );
}

export function buildThreeOaksExecutionBlueprints(protocol) {
  const blueprints = [];
  const betPerLine = protocol?.initial_bet_per_line ?? null;
  const lines = protocol?.initial_lines ?? null;

  if ((protocol?.actions || []).includes('spin')) {
    blueprints.push({
      kind: 'spin',
      id: 'spin',
      evidence: 'server_start',
      confidence: 'declared',
      request_template: {
        command: 'play',
        action: {
          name: 'spin',
          params: {
            bet_per_line: '<BET_PER_LINE>',
            lines: '<LINES>',
          },
        },
      },
      defaults: { bet_per_line: betPerLine, lines },
    });
  }

  for (const mode of protocol?.available_buy_bonus || []) {
    blueprints.push({
      kind: 'buy',
      id: `buy:${mode}`,
      mode,
      declared_multiplier: protocol?.buy_bonus_prices?.[String(mode)] ?? null,
      evidence: 'server_start',
      confidence: 'declared',
      request_template: {
        command: 'play',
        action: {
          name: 'buy_spin',
          params: {
            bet_per_line: '<BET_PER_LINE>',
            lines: '<LINES>',
            selected_mode: mode,
          },
        },
      },
      defaults: { bet_per_line: betPerLine, lines },
    });
  }

  for (const mode of protocol?.available_booster || []) {
    const anteBet = Number(protocol?.booster_prices?.[String(mode)]);
    blueprints.push({
      kind: 'booster',
      id: `booster:${mode}`,
      mode,
      ante_bet: Number.isFinite(anteBet) ? anteBet : null,
      declared_multiplier: Number.isFinite(anteBet) ? anteBet : null,
      evidence: 'server_start',
      confidence: 'declared',
      request_template: {
        command: 'play',
        action: {
          name: 'spin',
          params: {
            bet_per_line: '<BET_PER_LINE>',
            lines: '<LINES>',
            ante_bet: Number.isFinite(anteBet) ? anteBet : '<ANTE_BET>',
            selected_mode: mode,
          },
        },
      },
      defaults: { bet_per_line: betPerLine, lines },
    });
  }

  return blueprints;
}


export function threeOaksValidationSignature(discovery) {
  const protocol = discovery?.protocol || {};
  const actions = [...(protocol.actions || [])].sort();
  const unhandled = [...(protocol.unhandled_actions || [])].sort();
  return [
    discovery?.client_family || 'unknown',
    `actions=${actions.join(',')}`,
    `buy=${(protocol.available_buy_bonus || []).length}`,
    `booster=${(protocol.available_booster || []).length}`,
    `unhandled=${unhandled.join(',')}`,
  ].join('|');
}
