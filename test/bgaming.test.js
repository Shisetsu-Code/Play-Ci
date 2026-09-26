import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBgamingBootstrap,
  summarizeBgamingBootstrap,
  bgamingNeedsReview,
  buildBgamingExecutionBlueprints,
  bgamingCatalog,
} from '../src/providers/bgaming.js';

test('summarizes modern BGaming bets and feature multipliers', () => {
  const events = [
    {
      seq: 1,
      type: 'request',
      requestId: 'r1',
      method: 'POST',
      url: 'https://demo.bgaming-network.com/api/Alice/1/session',
      postData: JSON.stringify({command:'init'}),
      headers: {'content-type':'application/json'},
    },
    {
      seq: 2,
      type: 'responsebody',
      requestId: 'r1',
      url: 'https://demo.bgaming-network.com/api/Alice/1/session',
      body: JSON.stringify({
        api_version:'2',
        options:{
          available_bets:[20,100,2500],
          default_bet:100,
          lines:[[0,0,0],[1,1,1]],
          currency:{code:'FUN',subunits:100,exponent:2},
          feature_options:{
            feature_multipliers:{
              base_bet:20,
              bonus_chance:100,
              freespin_buy:{'0':2000,'1':5000},
            },
            disabled_features:[],
          },
        },
        balance:{game:0,wallet:100000},
        flow:{command:'init',available_actions:['init','spin']},
      }),
    },
  ];

  const start=extractBgamingBootstrap(events);
  assert.ok(start);
  const p=summarizeBgamingBootstrap(start);
  assert.equal(p.generation,'v2');
  assert.deepEqual(p.display_bets,[0.2,1,25]);
  assert.equal(p.default_bet_display,1);
  assert.deepEqual(p.actions,['init','spin']);
  assert.deepEqual(
    p.special_modes.map(x=>[x.kind,x.feature,x.level,x.multiplier]),
    [
      ['booster','bonus_chance',null,5],
      ['buy','freespin_buy','0',100],
      ['buy','freespin_buy','1',250],
    ],
  );
  assert.equal(bgamingNeedsReview(p),false);

  const blueprints=buildBgamingExecutionBlueprints(p);
  assert.equal(blueprints.length,4);
  assert.equal(blueprints[1].request_template.options.purchased_feature,'bonus_chance');
});

test('summarizes legacy line bets and fixed buy value', () => {
  const start={
    body:{
      options:{
        line_bets:[1,2,10,100],
        default_bet:1,
        lines:Array.from({length:10},()=>[0,0,0]),
        currency:{code:'FUN',subunits:100,exponent:2},
        buy_feature_value:97,
      },
      game:{state:'idle'},
      available_commands:['init','spin'],
    },
    request:null,
  };

  const p=summarizeBgamingBootstrap(start);
  assert.equal(p.generation,'legacy');
  assert.equal(p.bet_encoding,'line_bet_subunits');
  assert.deepEqual(p.display_bets,[0.1,0.2,1,10]);
  assert.equal(p.default_bet_display,0.1);
  assert.equal(p.buy_modes.length,1);
  assert.equal(p.buy_modes[0].feature,'buy_feature');
  assert.equal(p.buy_modes[0].multiplier,97);
  assert.equal(bgamingNeedsReview(p),false);

  const c=bgamingCatalog(p);
  assert.deepEqual(c.display_bets,[0.1,0.2,1,10]);
});

test('marks unknown BGaming bootstrap without bets for review', () => {
  const p=summarizeBgamingBootstrap({
    body:{options:{currency:{subunits:100}},available_commands:['init','spin']},
    request:null,
  });
  assert.equal(bgamingNeedsReview(p),true);
});
