function jsonBody(event) {
  if (event?.type !== 'responsebody' || !event.body) return null;
  try { return JSON.parse(event.body); } catch { return null; }
}

function requestFor(events, event) {
  return events.find((candidate) =>
    candidate.type === 'request' && candidate.requestId === event.requestId
  ) || null;
}

function parseRequestBody(request) {
  if (!request?.postData) return null;
  try { return JSON.parse(request.postData); } catch { return null; }
}

function isMainBootstrap(body) {
  if (!body || typeof body !== 'object' || !body.options || typeof body.options !== 'object') {
    return false;
  }
  return Boolean(
    body.api_version != null ||
    body.flow ||
    body.game ||
    body.available_commands
  );
}

export function extractBgamingJsonRpcInit(events) {
  const candidates = [];
  for (const event of events) {
    const body = jsonBody(event);
    if (body?.jsonrpc !== '2.0' || !body?.result?.config) continue;
    const request = requestFor(events, event);
    const requestBody = parseRequestBody(request);
    if (requestBody?.method !== 'init') continue;
    if (!Array.isArray(body.result.config.bet_limits)) continue;

    candidates.push({
      body,
      request: request ? {
        method: request.method,
        url: request.url,
        headers: request.headers || {},
        postData: request.postData ?? null,
      } : null,
      command: 'init',
      score: 10,
    });
  }
  return candidates[0] || null;
}

export function extractBgamingBootstrap(events) {
  const candidates = [];
  for (const event of events) {
    const body = jsonBody(event);
    if (!isMainBootstrap(body)) continue;

    const request = requestFor(events, event);
    const requestBody = parseRequestBody(request);
    const url = request?.url || event.url || '';
    const command = requestBody?.command ?? body?.flow?.command ?? null;

    candidates.push({
      body,
      request: request ? {
        method: request.method,
        url: request.url,
        headers: request.headers || {},
        postData: request.postData ?? null,
      } : null,
      command,
      score:
        (/bgaming-network\.com\/api\//i.test(url) ? 4 : 0) +
        (command === 'init' ? 4 : 0) +
        (body.options?.available_bets ? 2 : 0) +
        (body.options?.line_bets ? 2 : 0),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}


export function extractBgamingUnrecognizedInit(events) {
  const candidates = [];
  for (const event of events) {
    const body = jsonBody(event);
    if (!body || typeof body !== 'object' || isMainBootstrap(body)) continue;

    const request = requestFor(events, event);
    const requestBody = parseRequestBody(request);
    const url = request?.url || event.url || '';
    if (requestBody?.command !== 'init') continue;
    if (!/bgaming-network\.com\/api\//i.test(url)) continue;

    candidates.push({
      body,
      request: request ? {
        method: request.method,
        url: request.url,
        headers: request.headers || {},
        postData: request.postData ?? null,
      } : null,
      command: 'init',
      score: Object.keys(body).length,
    });
  }

  candidates.sort((x, y) => y.score - x.score);
  return candidates[0] || null;
}

function finiteNumbers(value) {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter(Number.isFinite);
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e8) / 1e8;
}

function featureKind(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('buy')) return 'buy';
  if (n.includes('chance') || n.includes('ante') || n.includes('booster')) return 'booster';
  return 'feature';
}

function normalizeModernFeatures(options) {
  const featureOptions = options?.feature_options || {};
  const multipliers = featureOptions?.feature_multipliers || {};
  const disabled = new Set(
    (Array.isArray(featureOptions?.disabled_features) ? featureOptions.disabled_features : [])
      .map((entry) => String(entry))
  );

  const base = Number(multipliers.base_bet ?? options?.base_bet);
  const features = [];

  for (const [name, value] of Object.entries(multipliers)) {
    if (name === 'base_bet' || disabled.has(name)) continue;

    if (Number.isFinite(Number(value))) {
      const raw = Number(value);
      features.push({
        kind: featureKind(name),
        feature: name,
        level: null,
        raw_value: raw,
        multiplier: Number.isFinite(base) && base > 0 ? round(raw / base) : round(raw / 100),
        source: 'options.feature_options.feature_multipliers',
      });
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [level, levelValue] of Object.entries(value)) {
        if (!Number.isFinite(Number(levelValue))) continue;
        const raw = Number(levelValue);
        features.push({
          kind: featureKind(name),
          feature: name,
          level: String(level),
          raw_value: raw,
          multiplier: Number.isFinite(base) && base > 0 ? round(raw / base) : round(raw / 100),
          source: 'options.feature_options.feature_multipliers',
        });
      }
    }
  }

  return {
    base_bet_reference: Number.isFinite(base) ? base : null,
    disabled_features: [...disabled],
    features,
  };
}

function normalizeLegacyFeatures(options) {
  const value = Number(options?.buy_feature_value);
  if (!Number.isFinite(value)) return [];
  return [{
    kind: 'buy',
    feature: 'buy_feature',
    level: null,
    raw_value: value,
    multiplier: value,
    source: 'options.buy_feature_value',
  }];
}

export function summarizeBgamingBootstrap(start) {
  const body = start.body || {};
  const options = body.options || {};
  const currency = options.currency || {};
  const subunits = Number(currency.subunits || (Number.isFinite(Number(currency.exponent)) ? 10 ** Number(currency.exponent) : 100));
  const modernBets = finiteNumbers(options.available_bets);
  const lineBets = finiteNumbers(options.line_bets);
  const lineCount = Array.isArray(options.lines) ? options.lines.length : 0;
  const generation = modernBets.length ? 'v2' : lineBets.length ? 'legacy' : 'unknown';

  let rawBets = [];
  let displayBets = [];
  let betEncoding = null;

  if (modernBets.length) {
    rawBets = modernBets;
    displayBets = modernBets.map((bet) => round(bet / subunits));
    betEncoding = 'total_bet_subunits';
  } else if (lineBets.length) {
    rawBets = lineBets;
    displayBets = lineBets.map((lineBet) =>
      round((lineBet * Math.max(1, lineCount)) / subunits)
    );
    betEncoding = 'line_bet_subunits';
  }

  const modernFeatures = normalizeModernFeatures(options);
  const legacyFeatures = normalizeLegacyFeatures(options);
  const features = [...modernFeatures.features, ...legacyFeatures];

  const actions = Array.isArray(body.flow?.available_actions)
    ? body.flow.available_actions
    : Array.isArray(body.available_commands)
      ? body.available_commands
      : [];

  return {
    provider: 'bgaming',
    generation,
    api_version: body.api_version ?? null,
    actions,
    currency: {
      code: currency.code ?? null,
      symbol: currency.symbol ?? null,
      subunits: Number.isFinite(subunits) && subunits > 0 ? subunits : 100,
      exponent: currency.exponent ?? null,
    },
    bet_encoding: betEncoding,
    raw_bets: rawBets,
    display_bets: [...new Set(displayBets)].sort((a, b) => a - b),
    default_bet_raw: Number.isFinite(Number(options.default_bet)) ? Number(options.default_bet) : null,
    default_bet_display: Number.isFinite(Number(options.default_bet))
      ? generation === 'legacy'
        ? round((Number(options.default_bet) * Math.max(1, lineCount)) / subunits)
        : round(Number(options.default_bet) / subunits)
      : null,
    line_count: lineCount || null,
    lines: options.lines || [],
    layout: options.layout || null,
    base_bet_reference: modernFeatures.base_bet_reference,
    disabled_features: modernFeatures.disabled_features,
    purchased_feature_capabilities: [],
    special_modes: features,
    buy_modes: features.filter((entry) => entry.kind === 'buy'),
    boosters: features.filter((entry) => entry.kind === 'booster'),
    other_features: features.filter((entry) => entry.kind === 'feature'),
    bootstrap_maps: Object.keys(body).filter((key) => /^bet_to_/i.test(key)),
    balance: body.balance ?? null,
  };
}

export function summarizeBgamingJsonRpcInit(start) {
  const result = start?.body?.result || {};
  const config = result.config || {};
  const currency = result.currency_attributes || {};
  const subunits = Number(currency.subunits || (Number.isFinite(Number(currency.exponent)) ? 10 ** Number(currency.exponent) : 100));
  const rawBets = finiteNumbers(config.bet_limits);
  const purchased = Array.isArray(config.purchased_features)
    ? config.purchased_features.map((feature) => String(feature))
    : [];

  // JSONRPC `purchased_features` is an engine capability list, not a
  // game-specific declaration of visible purchases/prices. Do not promote
  // these aliases into wager modes until game-specific evidence resolves them.
  const specialModes = [];

  return {
    provider: 'bgaming',
    generation: 'jsonrpc',
    api_version: 'jsonrpc-2.0',
    actions: ['init', 'spin'],
    currency: {
      code: currency.code ?? result.currency ?? null,
      symbol: currency.symbol ?? null,
      subunits: Number.isFinite(subunits) && subunits > 0 ? subunits : 100,
      exponent: currency.exponent ?? null,
    },
    bet_encoding: 'total_bet_subunits',
    raw_bets: rawBets,
    display_bets: rawBets.map((bet) => round(bet / subunits)),
    default_bet_raw: Number.isFinite(Number(config.default_bet)) ? Number(config.default_bet) : null,
    default_bet_display: Number.isFinite(Number(config.default_bet))
      ? round(Number(config.default_bet) / subunits)
      : null,
    line_count: null,
    lines: [],
    layout: null,
    base_bet_reference: null,
    disabled_features: [],
    purchased_feature_capabilities: purchased,
    special_modes: specialModes,
    buy_modes: specialModes.filter((entry) => entry.kind === 'buy'),
    boosters: specialModes.filter((entry) => entry.kind === 'booster'),
    other_features: specialModes.filter((entry) => entry.kind === 'feature'),
    bootstrap_maps: [],
    balance: result.balance ?? null,
    jsonrpc: {
      state_lock: result.state_lock ?? null,
      rtp: config.rtp ?? null,
      displayed_rtp: config.displayed_rtp ?? null,
    },
  };
}

export function bgamingReviewReasons(protocol) {
  const reasons = [];
  if (!(protocol?.display_bets || []).length) {
    reasons.push({code:'NO_BETS_DECLARED'});
  }
  if (!['v2','legacy','jsonrpc'].includes(protocol?.generation)) {
    reasons.push({code:'UNKNOWN_BGAMING_GENERATION'});
  }
  if (
    protocol?.generation === 'jsonrpc' &&
    (protocol?.purchased_feature_capabilities || []).length > 0
  ) {
    reasons.push({
      code:'JSONRPC_FEATURE_CAPABILITIES_UNRESOLVED',
      capabilities:protocol.purchased_feature_capabilities,
    });
  }

  for (const mode of protocol?.special_modes || []) {
    if (mode.multiplier == null || !Number.isFinite(Number(mode.multiplier))) {
      reasons.push({
        code:'SPECIAL_MODE_PRICE_UNRESOLVED',
        feature:mode.feature,
        level:mode.level,
      });
    }
  }
  return reasons;
}

export function bgamingNeedsReview(protocol) {
  return bgamingReviewReasons(protocol).length > 0;
}

export function buildBgamingExecutionBlueprints(protocol) {
  const generation = protocol?.generation || 'unknown';

  if (generation === 'jsonrpc') {
    return [{
      kind:'spin',
      id:'spin',
      evidence:'server_init',
      confidence:'method_declared_wire_unmapped',
      wire_protocol:'jsonrpc-2.0',
      request_template:null,
      unresolved_reason:'JSONRPC_SPIN_WIRE_UNMAPPED',
    }];
  }

  const legacy = generation === 'legacy';
  const baseOptions = legacy
    ? {bets:'<LINE_BETS_MAP>'}
    : {bet:'<BET>'};
  const baseTemplate = {
    command:'spin',
    options:{...baseOptions},
  };
  if (legacy) {
    baseTemplate.extra_data = {round_series_id:'<ROUND_SERIES_ID>'};
  }

  const out = [{
    kind:'spin',
    id:'spin',
    evidence:legacy ? 'server_init+visible_wire_sample' : 'server_init',
    confidence:legacy ? 'family_validated' : 'declared',
    request_template:baseTemplate,
  }];

  for (const feature of protocol?.special_modes || []) {
    if (legacy && feature.feature !== 'buy_feature') {
      out.push({
        kind:feature.kind,
        id:`${feature.feature}:${feature.level ?? 'fixed'}`,
        feature:feature.feature,
        declared_level:feature.level,
        declared_multiplier:feature.multiplier,
        evidence:'server_init',
        confidence:'declared_wire_unmapped',
        request_template:null,
        unresolved_reason:'LEGACY_FEATURE_WIRE_UNMAPPED',
      });
      continue;
    }

    const options = legacy
      ? {...baseOptions, buy_feature:true}
      : {
          bet:'<BET>',
          purchased_feature:feature.feature,
        };
    if (!legacy && feature.level != null) {
      options.purchased_feature_level = String(feature.level);
    }

    const requestTemplate = {
      command:'spin',
      options,
    };
    if (legacy) {
      requestTemplate.extra_data = {round_series_id:'<ROUND_SERIES_ID>'};
    }

    out.push({
      kind:feature.kind,
      id:`${feature.feature}:${feature.level ?? 'fixed'}`,
      feature:feature.feature,
      declared_level:feature.level,
      declared_multiplier:feature.multiplier,
      evidence:legacy ? 'server_init+visible_wire_sample' : 'server_init',
      confidence:legacy ? 'family_validated' : 'declared',
      request_template:requestTemplate,
    });
  }
  return out;
}

export function bgamingCatalog(protocol) {
  return {
    raw_bets: protocol?.raw_bets || [],
    display_bets: protocol?.display_bets || [],
    bet_encoding: protocol?.bet_encoding ?? null,
    default_bet_raw: protocol?.default_bet_raw ?? null,
    default_bet_display: protocol?.default_bet_display ?? null,
    line_count: protocol?.line_count ?? null,
    special_modes: protocol?.special_modes || [],
    buy_modes: protocol?.buy_modes || [],
    boosters: protocol?.boosters || [],
    other_features: protocol?.other_features || [],
    purchased_feature_capabilities: protocol?.purchased_feature_capabilities || [],
  };
}
