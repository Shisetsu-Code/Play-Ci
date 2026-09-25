import test from 'node:test';
import assert from 'node:assert/strict';
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

test('extracts and summarizes 3Oaks start response', () => {
  const events = [
    {
      seq: 1,
      type: 'request',
      requestId: 'r1',
      method: 'POST',
      url: 'https://host/demo/?gsc=start',
      headers: { 'content-type': 'text/plain' },
      postData: '{"command":"start"}',
    },
    {
      seq: 2,
      type: 'responsebody',
      requestId: 'r1',
      url: 'https://host/demo/?gsc=start',
      body: JSON.stringify({
        command: 'start',
        session_id: 's1',
        context: {
          actions: ['spin', 'buy_spin', 'set_params'],
          available_buy_bonus: [1, 2],
          available_booster: [1, 2, 3],
          spins: { bet_per_line: 5, lines: 25 },
        },
        settings: {
          buy_bonus_prices: { '1': 75, '2': 200 },
          booster_prices: { '1': 1.75, '2': 3, '3': 7.5 },
          bets: [1, 2, 3],
          bet_factor: [20],
          currency_format: { denominator: 100 },
        },
      }),
    },
  ];

  const start = extractThreeOaksStart(events);
  assert.ok(start);
  assert.equal(start.request.url, 'https://host/demo/?gsc=start');

  const summary = summarizeThreeOaksStart(start);
  assert.deepEqual(summary.available_buy_bonus, [1, 2]);
  assert.deepEqual(summary.available_booster, [1, 2, 3]);
  assert.deepEqual(summary.unhandled_actions, ['set_params']);
  assert.equal(summary.display_bet, 1);
  assert.equal(threeOaksNeedsReview(summary), true);
});

test('validation plan defaults to one representative special mode per kind', () => {
  const discovery = {
    protocol: {
      actions: ['spin', 'buy_spin'],
      available_buy_bonus: [1, 2, 3],
      available_booster: [1, 2, 3],
      buy_bonus_prices: { '1': 30, '2': 75, '3': 150 },
      booster_prices: { '1': 1.75, '2': 3, '3': 7.5 },
    },
  };

  assert.deepEqual(buildThreeOaksValidationPlan(discovery), [
    { kind: 'buy', mode: 1, modeIndex: 0, declaredMultiplier: 30 },
    { kind: 'booster', mode: 1, modeIndex: 0, declaredMultiplier: 1.75 },
  ]);

  const all = buildThreeOaksValidationPlan(discovery, {
    validateBaseSpin: true,
    validateAllModes: true,
  });
  assert.equal(all.length, 7);
  assert.equal(all[0].kind, 'spin');
  assert.equal(all.at(-1).mode, 3);
});

test('classifies browser-native play request and correlated response', () => {
  const events = [
    {
      seq: 10,
      type: 'request',
      requestId: 'p1',
      method: 'POST',
      url: 'https://host/?gsc=play',
      postData: JSON.stringify({
        command: 'play',
        action: { name: 'buy_spin', params: { selected_mode: 1 } },
      }),
    },
    {
      seq: 11,
      type: 'response',
      requestId: 'p1',
      url: 'https://host/?gsc=play',
      status: 200,
    },
    {
      seq: 12,
      type: 'responsebody',
      requestId: 'p1',
      url: 'https://host/?gsc=play',
      body: JSON.stringify({
        status: { code: 'OK' },
        context: { last_action: 'buy_spin' },
      }),
    },
  ];

  const plays = classifyThreeOaksPlay(events, 9);
  assert.equal(plays.length, 1);
  assert.equal(plays[0].accepted, true);
  assert.equal(plays[0].request.action.name, 'buy_spin');
});


test('validation signature groups equivalent client/protocol shapes', () => {
  const a = {
    client_family: 'kendoo',
    protocol: {
      actions: ['buy_spin', 'spin'],
      available_buy_bonus: [1, 2, 3],
      available_booster: [],
      unhandled_actions: [],
    },
  };
  const b = {
    client_family: 'kendoo',
    protocol: {
      actions: ['spin', 'buy_spin'],
      available_buy_bonus: [10, 20, 30],
      available_booster: [],
      unhandled_actions: [],
    },
  };
  assert.equal(threeOaksValidationSignature(a), threeOaksValidationSignature(b));
});


test('builds execution blueprints directly from server declarations', () => {
  const protocol = {
    actions: ['spin', 'buy_spin'],
    unhandled_actions: [],
    available_buy_bonus: [1, 2],
    available_booster: [1, 2, 3],
    buy_bonus_prices: { '1': 75, '2': 200 },
    booster_prices: { '1': 1.75, '2': 3, '3': 7.5 },
    initial_bet_per_line: 5,
    initial_lines: 25,
  };

  const blueprints = buildThreeOaksExecutionBlueprints(protocol);
  assert.equal(blueprints.length, 6);

  const buy = blueprints.find((entry) => entry.id === 'buy:1');
  assert.equal(buy.request_template.action.name, 'buy_spin');
  assert.equal(buy.request_template.action.params.selected_mode, 1);
  assert.equal(buy.declared_multiplier, 75);

  const booster = blueprints.find((entry) => entry.id === 'booster:3');
  assert.equal(booster.request_template.action.name, 'spin');
  assert.equal(booster.request_template.action.params.selected_mode, 3);
  assert.equal(booster.request_template.action.params.ante_bet, 7.5);
});

test('review reasons distinguish structural gaps from price-only gaps', () => {
  const missingModes = {
    actions: ['spin', 'buy_spin'],
    unhandled_actions: [],
    available_buy_bonus: [],
    available_booster: [],
    buy_bonus_prices: {},
    booster_prices: {},
  };
  assert.equal(threeOaksNeedsReview(missingModes), true);
  assert.ok(
    threeOaksReviewReasons(missingModes).some((reason) => reason.code === 'BUY_ACTION_WITHOUT_DECLARED_MODES')
  );

  const missingBuyPrice = {
    actions: ['spin', 'buy_spin'],
    unhandled_actions: [],
    available_buy_bonus: [1],
    available_booster: [],
    buy_bonus_prices: {},
    booster_prices: {},
  };
  assert.equal(threeOaksNeedsReview(missingBuyPrice), false);
  assert.ok(
    threeOaksReviewReasons(missingBuyPrice).some((reason) => reason.code === 'BUY_MODE_PRICE_UNDECLARED')
  );
});


test('computes complete effective bet catalog across factors and line modes', () => {
  const result = threeOaksEffectiveBets({
    bets: [1, 2],
    bet_factor: [10, 30],
    lines: [1, 3],
    denominator: 100,
  });

  assert.deepEqual(result.raw_bets, [1, 2]);
  assert.deepEqual(result.factors, [10, 30]);
  assert.deepEqual(result.lines, [1, 3]);
  assert.deepEqual(result.by_factor, [
    { factor: 10, lines: 1, display_bets: [0.1, 0.2] },
    { factor: 30, lines: 3, display_bets: [0.3, 0.6] },
  ]);
  assert.deepEqual(result.display_bets, [0.1, 0.2, 0.3, 0.6]);
});


test('fixed-price buy_spin is complete without selected_mode', () => {
  const protocol = {
    actions: ['spin', 'buy_spin'],
    unhandled_actions: [],
    available_buy_bonus: [],
    available_booster: [],
    buy_bonus_prices: {},
    booster_prices: {},
    fixed_buy_multiplier: 100,
    initial_bet_per_line: 5,
    initial_lines: 20,
  };

  assert.equal(threeOaksNeedsReview(protocol), false);

  const plan = buildThreeOaksValidationPlan({ protocol });
  assert.deepEqual(plan, [
    {
      kind: 'buy',
      mode: null,
      modeIndex: null,
      fixed: true,
      declaredMultiplier: 100,
    },
  ]);

  const blueprint = buildThreeOaksExecutionBlueprints(protocol)
    .find((entry) => entry.id === 'buy:fixed');
  assert.ok(blueprint);
  assert.equal(blueprint.declared_multiplier, 100);
  assert.equal('selected_mode' in blueprint.request_template.action.params, false);
});


test('normalizes legacy buy_bonus_price arrays into zero-based buy modes', () => {
  const start = {
    body: {
      command: 'start',
      session_id: 'legacy',
      context: {
        actions: ['spin', 'buy_spin'],
        available_buy_bonus: [],
        available_booster: [],
        spins: { bet_per_line: 20, lines: 5 },
      },
      settings: {
        buy_bonus_price: [50, 100],
        bets: [1, 2],
        bet_factor: [5],
        lines: [5],
        currency_format: { denominator: 100 },
      },
    },
    request: null,
  };

  const summary = summarizeThreeOaksStart(start);
  assert.deepEqual(summary.available_buy_bonus, [0, 1]);
  assert.deepEqual(summary.buy_bonus_prices, { '0': 50, '1': 100 });
  assert.equal(summary.buy_mode_encoding, 'legacy_zero_based_index');
  assert.equal(summary.buy_price_source, 'settings.buy_bonus_price');
  assert.equal(threeOaksNeedsReview(summary), false);

  const plan = buildThreeOaksValidationPlan({ protocol: summary }, { validateAllModes: true });
  assert.deepEqual(plan.map((entry) => [entry.mode, entry.declaredMultiplier]), [
    [0, 50],
    [1, 100],
  ]);
});
