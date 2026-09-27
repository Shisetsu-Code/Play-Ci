function responseSources(events) {
  return (events || [])
    .filter((event) =>
      event?.type === 'responsebody' &&
      typeof event.body === 'string' &&
      event.body.length >= 40 &&
      /\.(?:js|mjs|json)(?:\?|$)/i.test(event.url || '')
    )
    .map((event) => ({url:event.url || '', body:event.body}));
}

function literalValue(token, constants, depth = 0) {
  if (token == null || depth > 4) return null;
  const value = String(token).trim();

  if (/^".*"$/.test(value)) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (/^'.*'$/.test(value)) return value.slice(1, -1);
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === 'true' || value === '!0') return true;
  if (value === 'false' || value === '!1') return false;

  if (/^[A-Za-z_$][\w$]*$/.test(value) && constants.has(value)) {
    return literalValue(constants.get(value), constants, depth + 1);
  }
  return null;
}

function simpleConstants(source) {
  const constants = new Map();
  const assignment = /(?:\b(?:const|let|var)\s+|,)([A-Za-z_$][\w$]*)\s*=\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|-?\d+(?:\.\d+)?)(?=\s*[,;])/g;

  for (const match of source.matchAll(assignment)) {
    constants.set(match[1], match[2]);
  }
  return constants;
}

function fieldToken(objectText, key) {
  const token = '(?:"(?:\\\\.|[^"])*"|\'(?:\\\\.|[^\'])*\'|-?\\d+(?:\\.\\d+)?|!0|!1|true|false|[A-Za-z_$][\\w$]*)';
  const re = new RegExp('\\b' + key + '\\s*:\\s*(' + token + ')');
  return objectText.match(re)?.[1] ?? null;
}

function modeKind(feature, activation) {
  const name = String(feature || '').toLowerCase();
  if (name === 'buy_chance') return 'booster';
  if (activation === true && name.includes('chance')) return 'booster';
  return 'buy';
}

function sourceRequestSecondaryKey(source) {
  const candidates = new Map();
  const objectRe = /\{[^{}]{0,900}\bpurchased_feature\s*:[^{}]{0,900}\}/g;
  const keys = [
    'buy_id',
    'bonus_buy',
    'custom_field',
    'feature_id',
    'buy_feature_id',
    'bonus_multiplier_type',
    'machineId',
  ];

  for (const match of source.matchAll(objectRe)) {
    const text = match[0];
    for (const key of keys) {
      if (new RegExp('\\b' + key + '\\s*:').test(text)) {
        candidates.set(key, (candidates.get(key) || 0) + 1);
      }
    }
  }

  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function shopModes(source, sourceUrl) {
  if (!/\bpurchaseFeature\s*:/.test(source)) return null;

  const constants = simpleConstants(source);
  const secondaryKey = sourceRequestSecondaryKey(source);
  const modes = [];
  const objectRe = /\{[^{}]{0,1900}\bpurchaseFeature\s*:\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[A-Za-z_$][\w$]*)[^{}]{0,1900}\}/g;

  for (const match of source.matchAll(objectRe)) {
    const text = match[0];
    const feature = literalValue(fieldToken(text, 'purchaseFeature'), constants);
    const id = literalValue(fieldToken(text, 'id'), constants);
    const price = literalValue(fieldToken(text, 'price'), constants);
    const activation = literalValue(fieldToken(text, 'activation'), constants);

    if (typeof feature !== 'string' || typeof id !== 'string' || !Number.isFinite(Number(price))) {
      continue;
    }
    if (!/^buy_|^bonus_|^freespin_/i.test(feature)) continue;

    const requestFields = {purchased_feature:feature};
    if (secondaryKey) requestFields[secondaryKey] = id;

    modes.push({
      kind:modeKind(feature, activation),
      feature,
      id,
      level:id,
      multiplier:Number(price),
      raw_value:Number(price),
      activation:activation === true,
      request_fields:requestFields,
      wire_complete:Boolean(secondaryKey),
      source:'client_static_shop',
      evidence_url:sourceUrl,
    });
  }

  const unique = dedupeModes(modes);
  if (!unique.length) return null;

  return {
    source:'client_static_shop',
    catalog_complete:true,
    wire_complete:Boolean(secondaryKey),
    request_shape:secondaryKey ? [secondaryKey] : [],
    modes:unique,
    evidence_urls:[sourceUrl],
  };
}

function configuredModes(source, sourceUrl) {
  if (!/purchaseFeaturesConfig\s*:/.test(source)) return null;

  const modes = [];
  const objectRe = /\{[^{}]{0,1800}(?:configFeatureType|betPriceMultiplier)\s*:[^{}]{0,1800}\}/g;
  for (const match of source.matchAll(objectRe)) {
    const text = match[0];
    const id = literalValue(fieldToken(text, 'id'), new Map());
    const type = literalValue(fieldToken(text, 'type'), new Map());
    const price = literalValue(
      fieldToken(text, 'price') ?? fieldToken(text, 'betPriceMultiplier'),
      new Map(),
    );

    if (typeof id !== 'string' || typeof type !== 'string' || !Number.isFinite(Number(price))) {
      continue;
    }
    if (!/^buy_/i.test(type)) continue;

    modes.push({
      kind:modeKind(type, true),
      feature:type,
      id,
      level:id,
      multiplier:Number(price),
      raw_value:Number(price),
      activation:type === 'buy_chance',
      request_fields:{
        purchased_feature:type,
        custom_field:id,
      },
      wire_complete:false,
      wire_requirements:['requestData', 'bet_type'],
      source:'client_static_purchase_config',
      evidence_url:sourceUrl,
    });
  }

  const unique = dedupeModes(modes);
  if (!unique.length) return null;

  return {
    source:'client_static_purchase_config',
    catalog_complete:true,
    wire_complete:false,
    request_shape:['custom_field'],
    modes:unique,
    evidence_urls:[sourceUrl],
  };
}

function chickenModes(source, sourceUrl) {
  if (!/feature_id\s*:/.test(source)) return null;

  const prices = source.match(
    /\{\s*buy_bonus\s*:\s*([0-9.]+)\s*,\s*buy_super_bonus\s*:\s*([0-9.]+)\s*,\s*buy_ultra_bonus\s*:\s*([0-9.]+)\s*\}/
  );
  if (!prices) return null;

  const constants = simpleConstants(source);
  const chanceReturn = source.match(
    /if\(\s*["']buy_chance["']\s*===\s*[A-Za-z_$][\w$]*\s*\)\s*return\s+([A-Za-z_$][\w$]*|[0-9.]+)/
  );
  const chanceMultiplier = chanceReturn
    ? literalValue(chanceReturn[1], constants)
    : null;

  const modes = [
    ...(Number.isFinite(Number(chanceMultiplier)) ? [{
      kind:'booster',
      feature:'buy_chance',
      id:'buy_chance',
      level:'buy_chance',
      multiplier:Number(chanceMultiplier),
      raw_value:Number(chanceMultiplier),
      activation:true,
      request_fields:{purchased_feature:'buy_chance', bet_type:'bet'},
      wire_complete:true,
      source:'client_static_feature_map',
      evidence_url:sourceUrl,
    }] : []),
    ...[
      ['buy_bonus', Number(prices[1])],
      ['buy_super_bonus', Number(prices[2])],
      ['buy_ultra_bonus', Number(prices[3])],
    ].map(([id, multiplier]) => ({
      kind:'buy',
      feature:'buy_bonus',
      id,
      level:id,
      multiplier,
      raw_value:multiplier,
      activation:false,
      request_fields:{
        purchased_feature:'buy_bonus',
        feature_id:id,
        bet_type:'bet',
      },
      wire_complete:true,
      source:'client_static_feature_map',
      evidence_url:sourceUrl,
    })),
  ];

  return {
    source:'client_static_feature_map',
    catalog_complete:modes.length === 4,
    wire_complete:true,
    request_shape:['feature_id'],
    modes,
    evidence_urls:[sourceUrl],
  };
}

function treasureModes(source, sourceUrl) {
  const prices = source.match(
    /\{\s*buy_chance\s*:\s*([0-9.]+)\s*,\s*buy_bonus\s*:\s*([0-9.]+)\s*,\s*buy_bonus_and_chance\s*:\s*([0-9.]+)\s*\}/
  );
  if (!prices || !/\bmachineId\s*:/.test(source)) return null;

  const machine = source.match(/\bmachineId\s*:\s*["'](\d+)["']/);
  if (!machine) return null;
  const machineId = Number(machine[1]);

  const definitions = [
    ['buy_chance', Number(prices[1])],
    ['buy_bonus', Number(prices[2])],
    ['buy_bonus_and_chance', Number(prices[3])],
  ];

  return {
    source:'client_static_machine_profile',
    catalog_complete:true,
    wire_complete:true,
    request_shape:['machineId'],
    modes:definitions.map(([feature, multiplier]) => ({
      kind:feature === 'buy_chance' ? 'booster' : 'buy',
      feature,
      id:feature,
      level:feature,
      multiplier,
      raw_value:multiplier,
      activation:feature === 'buy_chance',
      request_fields:{purchased_feature:feature, machineId},
      wire_complete:true,
      source:'client_static_machine_profile',
      evidence_url:sourceUrl,
    })),
    evidence_urls:[sourceUrl],
  };
}


function jsonBuyFeatureModes(source, sourceUrl) {
  let body;
  try { body = JSON.parse(source); } catch { return null; }

  const groups = [];
  const seen = new Set();

  function visit(value, path = '', depth = 0) {
    if (value == null || depth > 12) return;
    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(value.length, 200); i++) {
        visit(value[i], path + '[' + i + ']', depth + 1);
      }
      return;
    }
    if (typeof value !== 'object') return;

    if (value.buyFeatureInfo && Array.isArray(value.buyFeatureInfo.configs)) {
      const key = path + '.buyFeatureInfo.configs';
      if (!seen.has(key)) {
        seen.add(key);
        groups.push({path:key, configs:value.buyFeatureInfo.configs});
      }
    }

    for (const [key, child] of Object.entries(value)) {
      const next = path ? path + '.' + key : key;
      visit(child, next, depth + 1);
    }
  }

  visit(body);
  const modes = [];

  for (const group of groups) {
    for (const config of group.configs) {
      const feature = config?.purchasedFeature;
      const id = config?.buyFeatureId;
      const percent = Number(config?.pricePercent);
      if (typeof feature !== 'string' || id == null || !Number.isFinite(percent)) continue;

      const multiplier = roundPricePercent(percent);
      modes.push({
        kind:modeKind(feature, feature === 'buy_chance'),
        feature,
        id:String(id),
        level:String(id),
        multiplier,
        raw_value:percent,
        activation:feature === 'buy_chance',
        request_fields:{
          purchased_feature:feature,
          buy_feature_id:id,
        },
        wire_complete:true,
        source:'client_json_buy_feature_config',
        evidence_url:sourceUrl,
      });
    }
  }

  const unique = dedupeModes(modes);
  if (!unique.length) return null;

  return {
    source:'client_json_buy_feature_config',
    catalog_complete:true,
    wire_complete:true,
    request_shape:['buy_feature_id'],
    modes:unique,
    evidence_urls:[sourceUrl],
  };
}

function roundPricePercent(value) {
  return Math.round((Number(value) / 100 + Number.EPSILON) * 1e8) / 1e8;
}

function definitionModes(source, sourceUrl) {
  let body;
  try { body = JSON.parse(source); } catch { return null; }
  const definition = body?.engine?.definition;
  if (!definition || typeof definition !== 'object') return null;

  const modes = [];

  const normal = Number(definition.normalBuyCost);
  const superBuy = Number(definition.superBuyCost);
  if (Number.isFinite(normal) && Number.isFinite(superBuy)) {
    modes.push(
      {
        kind:'buy',
        feature:'buy_bonus',
        id:'normal',
        level:'normal',
        multiplier:normal,
        raw_value:normal,
        activation:false,
        request_fields:{purchased_feature:'buy_bonus'},
        wire_complete:false,
        wire_requirements:['custom_req.buy_mode'],
        source:'engine_definition_buy_costs',
        evidence_url:sourceUrl,
      },
      {
        kind:'buy',
        feature:'buy_bonus',
        id:'super',
        level:'super',
        multiplier:superBuy,
        raw_value:superBuy,
        activation:false,
        request_fields:{purchased_feature:'buy_bonus'},
        wire_complete:false,
        wire_requirements:['custom_req.buy_mode'],
        source:'engine_definition_buy_costs',
        evidence_url:sourceUrl,
      },
    );
  }

  const freespin = Number(definition.featureBuyMulFreespin);
  const respin = Number(definition.featureBuyMulRespin);
  if (Number.isFinite(freespin) && Number.isFinite(respin)) {
    modes.push(
      {
        kind:'buy',
        feature:'buy_bonus',
        id:'freespin',
        level:'freespin',
        multiplier:freespin,
        raw_value:freespin,
        activation:false,
        request_fields:{purchased_feature:'buy_bonus'},
        wire_complete:false,
        wire_requirements:['custom_req.isFeatureBuyFreeSpin'],
        source:'engine_definition_feature_buy_multipliers',
        evidence_url:sourceUrl,
      },
      {
        kind:'buy',
        feature:'buy_bonus',
        id:'respin',
        level:'respin',
        multiplier:respin,
        raw_value:respin,
        activation:false,
        request_fields:{purchased_feature:'buy_bonus'},
        wire_complete:false,
        wire_requirements:['custom_req.isFeatureBuyRespin'],
        source:'engine_definition_feature_buy_multipliers',
        evidence_url:sourceUrl,
      },
    );
  }

  const unique = dedupeModes(modes);
  if (!unique.length) return null;

  return {
    source:unique[0].source,
    catalog_complete:true,
    wire_complete:false,
    request_shape:[],
    modes:unique,
    evidence_urls:[sourceUrl],
  };
}

function bonusMultiplierModes(source, sourceUrl) {
  if (!/bonus_multiplier_type\s*:/.test(source)) return null;
  if (!/purchased_feature\s*:\s*["']buy_bonus["']/.test(source)) return null;

  const types = [...source.matchAll(
    /purchased_feature\s*:\s*["']buy_bonus["'][^{}]{0,240}bonus_multiplier_type\s*:\s*["']([^"']+)["']/g
  )].map((match) => match[1]);

  const pricesMatch = source.match(
    /const\s+[A-Za-z_$][\w$]*\s*=\s*[^,;]+,\s*([A-Za-z_$][\w$]*)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*\*\s*[A-Za-z_$][\w$]*\.bet\s*,\s*([A-Za-z_$][\w$]*)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*\*\s*[A-Za-z_$][\w$]*\.bet/
  );

  const orderedTypes = [...new Set(types)].slice(0, 2);
  const prices = pricesMatch ? [Number(pricesMatch[2]), Number(pricesMatch[4])] : [];
  const modes = [];

  if (orderedTypes.length === 2 && prices.length === 2) {
    for (let i = 0; i < 2; i++) {
      modes.push({
        kind:'buy',
        feature:'buy_bonus',
        id:orderedTypes[i],
        level:orderedTypes[i],
        multiplier:prices[i],
        raw_value:prices[i],
        activation:false,
        request_fields:{
          purchased_feature:'buy_bonus',
          bonus_multiplier_type:orderedTypes[i],
        },
        wire_complete:true,
        source:'client_static_bonus_multiplier',
        evidence_url:sourceUrl,
      });
    }
  }

  let chanceMultiplier = null;
  const chanceLiteral = source.match(/\bgoldenBetMulti\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
  if (chanceLiteral) chanceMultiplier = Number(chanceLiteral[1]);

  if (
    Number.isFinite(chanceMultiplier) &&
    /purchased_feature[^;}]{0,320}["']buy_chance["']/.test(source)
  ) {
    modes.unshift({
      kind:'booster',
      feature:'buy_chance',
      id:'buy_chance',
      level:'buy_chance',
      multiplier:chanceMultiplier,
      raw_value:chanceMultiplier,
      activation:true,
      request_fields:{
        purchased_feature:'buy_chance',
        bet_type:'bet',
      },
      wire_complete:true,
      source:'client_static_bonus_multiplier',
      evidence_url:sourceUrl,
    });
  }

  const unique = dedupeModes(modes);
  if (unique.length < 2) return null;

  return {
    source:'client_static_bonus_multiplier',
    catalog_complete:unique.length >= 3,
    wire_complete:true,
    request_shape:['bonus_multiplier_type'],
    modes:unique,
    evidence_urls:[sourceUrl],
  };
}


function yommiFeatureModes(source, sourceUrl) {
  if (!/FEATURE_BET_MULTIPLIER/.test(source) || !/PURCHASED_FEATURES/.test(source)) return null;

  const prices = source.match(
    /FEATURE_BET_MULTIPLIER\s*=\s*[^;]{0,1200}?BONUS\s*,\s*(\d+)n?[^;]{0,600}?SUPER_BONUS\s*,\s*(\d+)n?[^;]{0,600}?MORE_PETS\s*,\s*(\d+)n?/
  );
  if (!prices) return null;

  const mappings = {
    MORE_PETS:'buy_chance',
    BONUS:'buy_bonus',
    SUPER_BONUS:'buy_bonus_and_chance',
  };
  const values = {
    BONUS:Number(prices[1]),
    SUPER_BONUS:Number(prices[2]),
    MORE_PETS:Number(prices[3]),
  };
  const hasModelRev = /\bmodelRev\b/.test(source);
  const hasMinExponent = /\bminExponent\b/.test(source);

  const modes = ['MORE_PETS','BONUS','SUPER_BONUS'].map((id) => {
    const feature = mappings[id];
    const request_fields = {
      purchased_feature:feature,
      bet_type:'bet',
    };
    if (hasModelRev) request_fields.modelRev = 0;
    if (hasMinExponent) request_fields.minExponent = 2;
    return {
      kind:feature === 'buy_chance' ? 'booster' : 'buy',
      feature,
      id:id.toLowerCase(),
      level:id.toLowerCase(),
      multiplier:values[id],
      raw_value:values[id],
      activation:feature === 'buy_chance',
      request_fields,
      wire_complete:true,
      source:'client_static_feature_multiplier_map',
      evidence_url:sourceUrl,
    };
  });

  return {
    source:'client_static_feature_multiplier_map',
    catalog_complete:true,
    wire_complete:true,
    request_shape:[
      ...(hasModelRev ? ['modelRev'] : []),
      ...(hasMinExponent ? ['minExponent'] : []),
    ],
    modes,
    evidence_urls:[sourceUrl],
  };
}

function fsMultiplierBuyMode(source, sourceUrl) {
  const multiplierMatch = source.match(/\bfsMultiplier\s*=\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!multiplierMatch) return null;
  if (!/purchasedFeatures\.some\([^)]*["']buy_bonus["']/.test(source)) return null;
  if (!/purchased_feature/.test(source)) return null;

  const multiplier = Number(multiplierMatch[1]);
  if (!Number.isFinite(multiplier) || multiplier <= 1) return null;

  const betType = /bet_type[^"']{0,120}["']default["']/.test(source) ? 'default' : 'bet';
  return {
    source:'client_static_fs_multiplier',
    catalog_complete:true,
    wire_complete:true,
    request_shape:['purchased_feature','bet_type'],
    modes:[{
      kind:'buy',
      feature:'buy_bonus',
      id:'buy_bonus',
      level:'buy_bonus',
      multiplier,
      raw_value:multiplier,
      activation:false,
      request_fields:{
        purchased_feature:'buy_bonus',
        bet_type:betType,
      },
      wire_complete:true,
      source:'client_static_fs_multiplier',
      evidence_url:sourceUrl,
    }],
    evidence_urls:[sourceUrl],
  };
}


function bigBucksModes(source, sourceUrl) {
  const multiplierMatch = source.match(/\bbuyBonusMultiplier\s*=\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!multiplierMatch) return null;
  if (!/purchased_feature\s*:\s*["']buy_bonus["']/.test(source)) return null;
  if (!/bonusPrices\.freespin_buy/.test(source)) return null;

  const multiplier = Number(multiplierMatch[1]);
  if (!Number.isFinite(multiplier) || multiplier <= 1) return null;

  return {
    source:'client_static_buy_bonus_multiplier',
    catalog_complete:true,
    wire_complete:true,
    request_shape:['purchased_feature'],
    modes:[{
      kind:'buy',
      feature:'buy_bonus',
      id:'buy_bonus',
      level:'buy_bonus',
      multiplier,
      raw_value:multiplier,
      activation:false,
      request_fields:{purchased_feature:'buy_bonus'},
      wire_complete:true,
      source:'client_static_buy_bonus_multiplier',
      evidence_url:sourceUrl,
    }],
    evidence_urls:[sourceUrl],
  };
}

function blazingFirepotsModes(source, sourceUrl) {
  if (!/purchased_feature\s*:\s*["']buy_bonus["']/.test(source)) return null;
  if (!/purchased_feature\s*:\s*["']buy_chance["']/.test(source)) return null;

  const buy = source.match(/formatMoney\(\s*([0-9]+(?:\.[0-9]+)?)\s*\*\s*[A-Za-z_$][\w$]*\s*\)/);
  const chance = source.match(/isAnteSpinActive\s*\?\s*([0-9]+(?:\.[0-9]+)?)\s*\*\s*[A-Za-z_$][\w$]*/);
  if (!buy || !chance) return null;

  const buyMultiplier = Number(buy[1]);
  const chanceMultiplier = Number(chance[1]);
  if (!Number.isFinite(buyMultiplier) || !Number.isFinite(chanceMultiplier)) return null;

  return {
    source:'client_static_blazing_feature_prices',
    catalog_complete:true,
    wire_complete:true,
    request_shape:['purchased_feature','bet_type'],
    modes:[
      {
        kind:'booster',
        feature:'buy_chance',
        id:'buy_chance',
        level:'buy_chance',
        multiplier:chanceMultiplier,
        raw_value:chanceMultiplier,
        activation:true,
        request_fields:{
          purchased_feature:'buy_chance',
          bet_type:'betting',
        },
        wire_complete:true,
        source:'client_static_blazing_feature_prices',
        evidence_url:sourceUrl,
      },
      {
        kind:'buy',
        feature:'buy_bonus',
        id:'buy_bonus',
        level:'buy_bonus',
        multiplier:buyMultiplier,
        raw_value:buyMultiplier,
        activation:false,
        request_fields:{
          purchased_feature:'buy_bonus',
          bet_type:'betting',
        },
        wire_complete:true,
        source:'client_static_blazing_feature_prices',
        evidence_url:sourceUrl,
      },
    ],
    evidence_urls:[sourceUrl],
  };
}

function sweetSamuraiModes(source, sourceUrl) {
  const costs = source.match(
    /BUY_BONUS_COSTS["']?\s*,?\s*\{\s*DEEP_SPIN\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*DEEP_BONANZA\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*\}/
  ) || source.match(
    /BUY_BONUS_COSTS[^{}]{0,100}\{\s*DEEP_SPIN\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*DEEP_BONANZA\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*\}/
  );
  if (!costs) return null;
  if (!/DEEP_SPIN\s*=\s*["']deep_spin["']/.test(source)) return null;
  if (!/DEEP_BONANZA\s*=\s*["']deep_bonanza["']/.test(source)) return null;

  const modes = [
    ['deep_spin', Number(costs[1])],
    ['deep_bonanza', Number(costs[2])],
  ].map(([id, multiplier]) => ({
    kind:'buy',
    feature:'buy_bonus',
    id,
    level:id,
    multiplier,
    raw_value:multiplier,
    activation:false,
    request_fields:null,
    wire_complete:false,
    wire_requirements:['game_specific_buy_bonus_wire'],
    source:'client_static_buy_bonus_costs',
    evidence_url:sourceUrl,
  }));

  return {
    source:'client_static_buy_bonus_costs',
    catalog_complete:true,
    wire_complete:false,
    request_shape:[],
    modes,
    evidence_urls:[sourceUrl],
  };
}


function mysticReelsModes(source, sourceUrl) {
  if (!/RESPIN_BUY/.test(source) || !/BONUS_BUY/.test(source)) return null;
  if (!/request\.bet\s*=\s*\(request\.bet\s*\*\s*2\)\s*\/\s*3/.test(source)) return null;
  if (!/request\.bet\s*\/=\s*100/.test(source)) return null;
  if (!/RESPIN_BUY["']?\s*:\s*return\s*["']buy_chance["']/.test(source) &&
      !/case\s*["']RESPIN_BUY["']\s*:\s*return\s*["']buy_chance["']/.test(source)) return null;
  if (!/case\s*["']BONUS_BUY["']\s*:\s*return\s*["']buy_bonus["']/.test(source)) return null;

  return {
    source:'client_static_mode_transform',
    catalog_complete:true,
    wire_complete:true,
    request_shape:['purchased_feature','bet_transform'],
    modes:[
      {
        kind:'booster',
        feature:'buy_chance',
        id:'respin_buy',
        level:'respin_buy',
        multiplier:1.5,
        raw_value:1.5,
        activation:true,
        request_fields:{
          bet:'<BASE_BET_SUBUNITS>',
          purchased_feature:'buy_chance',
        },
        bet_transform:'visible_stake / 1.5',
        wire_complete:true,
        source:'client_static_mode_transform',
        evidence_url:sourceUrl,
      },
      {
        kind:'buy',
        feature:'buy_bonus',
        id:'bonus_buy',
        level:'bonus_buy',
        multiplier:100,
        raw_value:100,
        activation:false,
        request_fields:{
          bet:'<BASE_BET_SUBUNITS>',
          purchased_feature:'buy_bonus',
        },
        bet_transform:'visible_stake / 100',
        wire_complete:true,
        source:'client_static_mode_transform',
        evidence_url:sourceUrl,
      },
    ],
    evidence_urls:[sourceUrl],
  };
}

function clashOfGodsModes(source, sourceUrl) {
  const values = source.match(
    /buyBonusModeMultiplier1\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*this\.buyBonusModeMultiplier2\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*this\.businessmanModeMultiplier1\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*this\.businessmanModeMultiplier2\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*this\.businessmanModeMultiplier3\s*=\s*([0-9]+(?:\.[0-9]+)?)/
  );
  if (!values) return null;
  if (!/feature_buy\s*:/.test(source) || !/buyBonusModeMultiplier\s*:/.test(source)) return null;
  if (!/ante_0=["']ante_0["']/.test(source) || !/ante_1=["']ante_1["']/.test(source) || !/ante_2=["']ante_2["']/.test(source)) return null;
  if (!/buy_bonus=["']buy_bonus["']/.test(source) || !/super_buy_bonus=["']super_buy_bonus["']/.test(source)) return null;

  const buy1 = Number(values[1]);
  const buy2 = Number(values[2]);
  const ante1 = Number(values[3]);
  const ante0 = Number(values[4]);
  const ante2 = Number(values[5]);

  const common = {
    bet_type:'default',
    fe_exponent:'<FE_EXPONENT>',
    bonus_type:'<BONUS_TYPE>',
  };

  const modes = [
    ['booster','buy_chance','ante_1',ante1,1],
    ['booster','buy_chance','ante_0',ante0,1],
    ['booster','buy_chance','ante_2',ante2,1],
    ['buy','buy_bonus','buy_bonus',buy1,buy1],
    ['buy','buy_bonus','super_buy_bonus',buy2,buy2],
  ].map(([kind, feature, id, multiplier, buyBonusModeMultiplier]) => ({
    kind,
    feature,
    id,
    level:id,
    multiplier:Number(multiplier),
    raw_value:Number(multiplier),
    activation:kind === 'booster',
    request_fields:{
      ...common,
      feature_buy:id,
      purchased_feature:feature,
      buyBonusModeMultiplier:Number(buyBonusModeMultiplier),
    },
    wire_complete:true,
    source:'client_static_feature_buy_map',
    evidence_url:sourceUrl,
  }));

  return {
    source:'client_static_feature_buy_map',
    catalog_complete:true,
    wire_complete:true,
    request_shape:['feature_buy','purchased_feature','buyBonusModeMultiplier','bonus_type','fe_exponent'],
    modes,
    evidence_urls:[sourceUrl],
  };
}


function redHotChilliChickensModes(source, sourceUrl) {
  if (!/purchased_feature\s*:\s*["']bonus_buy["']/.test(source)) return null;
  if (!/\bisSuperBonus\b/.test(source)) return null;

  const prices = source.match(
    /isSuperBonus\s*\?\s*([0-9]+(?:\.[0-9]+)?)\s*:\s*([0-9]+(?:\.[0-9]+)?)/
  );
  if (!prices) return null;

  const superMultiplier = Number(prices[1]);
  const normalMultiplier = Number(prices[2]);
  if (!Number.isFinite(normalMultiplier) || !Number.isFinite(superMultiplier)) return null;

  const betType = /bet_type\s*:\s*["']betting["']/.test(source) ? 'betting' : 'bet';

  return {
    source:'client_static_bonus_buy_variants',
    catalog_complete:true,
    wire_complete:true,
    request_shape:['purchased_feature','isSuperBonus','bet_type'],
    modes:[
      {
        kind:'buy',
        feature:'bonus_buy',
        id:'bonus_buy',
        level:'normal',
        multiplier:normalMultiplier,
        raw_value:normalMultiplier,
        activation:false,
        request_fields:{
          purchased_feature:'bonus_buy',
          isSuperBonus:false,
          bet_type:betType,
        },
        wire_complete:true,
        source:'client_static_bonus_buy_variants',
        evidence_url:sourceUrl,
      },
      {
        kind:'buy',
        feature:'bonus_buy',
        id:'super_bonus_buy',
        level:'super',
        multiplier:superMultiplier,
        raw_value:superMultiplier,
        activation:false,
        request_fields:{
          purchased_feature:'bonus_buy',
          isSuperBonus:true,
          bet_type:betType,
        },
        wire_complete:true,
        source:'client_static_bonus_buy_variants',
        evidence_url:sourceUrl,
      },
    ],
    evidence_urls:[sourceUrl],
  };
}


function jokerVsJokerModes(source, sourceUrl) {
  const multipliers = source.match(
    /busnesssmanModeMultiplier\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*this\.buyBonusModeMultiplier\s*=\s*([0-9]+(?:\.[0-9]+)?)/
  );
  if (!multipliers) return null;

  if (!/businessmanMode\s*\?\s*["']buy_chance["']/.test(source)) return null;
  if (!/["']buy_bonus["']\s*==\s*[A-Za-z_$][\w$]*/.test(source)) return null;
  if (!/purchased_feature\s*:/.test(source) || !/buyBonusModeMultiplier\s*:/.test(source)) return null;

  const booster = Number(multipliers[1]);
  const buy = Number(multipliers[2]);
  if (!Number.isFinite(booster) || !Number.isFinite(buy)) return null;

  const common = {
    bet_type:'default',
    fe_exponent:'<FE_EXPONENT>',
    balance:'<BALANCE>',
  };

  return {
    source:'client_static_joker_mode_multipliers',
    catalog_complete:true,
    wire_complete:true,
    request_shape:['purchased_feature','buyBonusModeMultiplier','fe_exponent','balance'],
    modes:[
      {
        kind:'booster',
        feature:'buy_chance',
        id:'businessman_mode',
        level:'businessman_mode',
        multiplier:booster,
        raw_value:booster,
        activation:true,
        request_fields:{
          ...common,
          purchased_feature:'buy_chance',
          buyBonusModeMultiplier:1,
        },
        wire_complete:true,
        source:'client_static_joker_mode_multipliers',
        evidence_url:sourceUrl,
      },
      {
        kind:'buy',
        feature:'buy_bonus',
        id:'buy_bonus',
        level:'buy_bonus',
        multiplier:buy,
        raw_value:buy,
        activation:false,
        request_fields:{
          ...common,
          purchased_feature:'buy_bonus',
          buyBonusModeMultiplier:buy,
        },
        wire_complete:true,
        source:'client_static_joker_mode_multipliers',
        evidence_url:sourceUrl,
      },
    ],
    evidence_urls:[sourceUrl],
  };
}


function buyDisabledConfig(source, sourceUrl) {
  let body;
  try { body = JSON.parse(source); } catch { return null; }

  const buyBtn = body?.bg_gaming?.buy_btn;
  if (!(buyBtn === false || String(buyBtn).toLowerCase() === 'false')) return null;

  return {
    source:'client_json_buy_disabled',
    catalog_complete:true,
    wire_complete:true,
    request_shape:[],
    modes:[],
    evidence_urls:[sourceUrl],
  };
}

function jungleQueenModes(source, sourceUrl) {
  const multiplier = source.match(/\bua\s*=\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!multiplier) return null;
  if (!/const\s+[A-Za-z_$][\w$]*\s*=\s*["']buybonus["']\s*,\s*[A-Za-z_$][\w$]*\s*=\s*["']buybonus["']/.test(source)) return null;
  if (!/purchased_feature\s*:\s*["']buy_bonus["']/.test(source)) return null;
  if (!/action\s*:\s*[A-Za-z_$][\w$]*\s*,\s*id\s*:\s*[A-Za-z_$][\w$]*/.test(source)) return null;

  const value = Number(multiplier[1]);
  if (!Number.isFinite(value) || value <= 1) return null;

  return {
    source:'client_static_jungle_buy',
    catalog_complete:true,
    wire_complete:true,
    request_shape:['action','id','purchased_feature'],
    modes:[{
      kind:'buy',
      feature:'buy_bonus',
      id:'buybonus',
      level:'buybonus',
      multiplier:value,
      raw_value:value,
      activation:false,
      request_fields:{
        action:'buybonus',
        id:'buybonus',
        purchased_feature:'buy_bonus',
      },
      wire_complete:true,
      source:'client_static_jungle_buy',
      evidence_url:sourceUrl,
    }],
    evidence_urls:[sourceUrl],
  };
}

function dedupeModes(modes) {
  const seen = new Set();
  const out = [];
  for (const mode of modes) {
    const key = JSON.stringify([
      mode.feature,
      mode.id,
      mode.multiplier,
      mode.request_fields,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mode);
  }
  return out;
}

function profileScore(profile) {
  if (!profile) return -1;
  return (
    (profile.catalog_complete ? 100 : 0) +
    (profile.wire_complete ? 20 : 0) +
    (profile.modes?.length || 0)
  );
}

export function extractBgamingJsonRpcStaticProfile(events) {
  const candidates = [];

  for (const source of responseSources(events)) {
    for (const extractor of [buyDisabledConfig, jungleQueenModes, jokerVsJokerModes, redHotChilliChickensModes, mysticReelsModes, clashOfGodsModes, bigBucksModes, blazingFirepotsModes, sweetSamuraiModes, yommiFeatureModes, fsMultiplierBuyMode, jsonBuyFeatureModes, definitionModes, bonusMultiplierModes, configuredModes, chickenModes, treasureModes, shopModes]) {
      const profile = extractor(source.body, source.url);
      if (profile) candidates.push(profile);
    }
  }

  candidates.sort((a, b) => profileScore(b) - profileScore(a));
  return candidates[0] || {
    source:null,
    catalog_complete:false,
    wire_complete:false,
    request_shape:[],
    modes:[],
    evidence_urls:[],
  };
}
