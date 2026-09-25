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
    denominator,
    initial_bet_per_line: context.spins?.bet_per_line ?? null,
    initial_lines: context.spins?.lines ?? null,
    display_bet: betFactor && denominator ? (betPerLine * betFactor) / denominator : null,
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

export function threeOaksNeedsReview(protocol) {
  return Boolean((protocol?.unhandled_actions || []).length);
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
