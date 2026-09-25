import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractThreeOaksStart,
  summarizeThreeOaksStart,
  buildThreeOaksValidationPlan,
  classifyThreeOaksPlay,
  threeOaksNeedsReview,
  threeOaksValidationSignature,
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
