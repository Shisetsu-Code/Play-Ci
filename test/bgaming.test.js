import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBgamingBootstrap,
  extractBgamingJsonRpcInit,
  extractBgamingUnrecognizedInit,
  summarizeBgamingBootstrap,
  summarizeBgamingAllLuckyCloverLauncher,
  summarizeBgamingJsonRpcInit,
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


test('summarizes BGaming JSONRPC bet limits', () => {
  const events=[
    {
      seq:1,type:'request',requestId:'j1',method:'POST',
      url:'https://game.demo.bgaming-network.com/api/',
      postData:JSON.stringify({jsonrpc:'2.0',method:'init',id:'1',params:{token:'t'}}),
    },
    {
      seq:2,type:'responsebody',requestId:'j1',url:'https://game.demo.bgaming-network.com/api/',
      body:JSON.stringify({
        id:'1',jsonrpc:'2.0',result:{
          currency:'FUN',
          currency_attributes:{code:'FUN',subunits:100,exponent:2},
          config:{
            bet_limits:[10,20,100,6500],
            default_bet:100,
            purchased_features:[],
          },
          balance:100000,
        }
      }),
    },
  ];

  const start=extractBgamingJsonRpcInit(events);
  assert.ok(start);
  const p=summarizeBgamingJsonRpcInit(start);
  assert.equal(p.generation,'jsonrpc');
  assert.deepEqual(p.display_bets,[0.1,0.2,1,65]);
  assert.equal(p.default_bet_display,1);
  assert.equal(bgamingNeedsReview(p),false);
});


test('BGaming v2 feature multipliers without base_bet use hundredths', () => {
  const p=summarizeBgamingBootstrap({
    body:{
      api_version:'2',
      options:{
        available_bets:[25,100],
        default_bet:25,
        currency:{subunits:100,exponent:2},
        feature_options:{
          feature_multipliers:{
            freespin_chance:132,
            bonus_buy:4000,
            freespin_buy:4800,
          },
          disabled_features:[],
        },
      },
      flow:{available_actions:['init','spin']},
    },
    request:null,
  });
  assert.deepEqual(
    p.special_modes.map(x=>[x.feature,x.multiplier]),
    [['freespin_chance',1.32],['bonus_buy',40],['freespin_buy',48]],
  );
  assert.equal(bgamingNeedsReview(p),false);
});

test('JSONRPC purchased_features remain unresolved capabilities, not wager modes', () => {
  const p=summarizeBgamingJsonRpcInit({
    body:{jsonrpc:'2.0',result:{
      currency_attributes:{code:'FUN',subunits:100},
      config:{
        bet_limits:[20,100],
        default_bet:100,
        purchased_features:['buy_bonus','bonus_buy','freespin_chance'],
      },
    }},
    request:null,
  });
  assert.deepEqual(p.special_modes,[]);
  assert.deepEqual(p.purchased_feature_capabilities,['buy_bonus','bonus_buy','freespin_chance']);
  assert.equal(bgamingNeedsReview(p),true);
});


test('legacy BGaming blueprints use observed bets map and buy_feature wire shape', () => {
  const p=summarizeBgamingBootstrap({
    body:{
      options:{
        line_bets:[1,2,10],
        default_bet:1,
        lines:Array.from({length:10},()=>[0,0,0]),
        currency:{code:'FUN',subunits:100,exponent:2},
        buy_feature_value:97,
      },
      game:{state:'idle'},
      available_commands:['init','spin'],
    },
    request:null,
  });
  const blueprints=buildBgamingExecutionBlueprints(p);
  assert.deepEqual(blueprints[0].request_template.options,{bets:'<LINE_BETS_MAP>'});
  assert.equal(blueprints[0].request_template.extra_data.round_series_id,'<ROUND_SERIES_ID>');
  assert.equal(blueprints[1].request_template.options.buy_feature,true);
  assert.equal(blueprints[1].request_template.options.purchased_feature,undefined);
});

test('JSONRPC base-spin blueprint uses the visible-click play wire shape', () => {
  const p=summarizeBgamingJsonRpcInit({
    body:{jsonrpc:'2.0',result:{
      currency_attributes:{code:'FUN',subunits:100},
      config:{bet_limits:[20,100],default_bet:100,purchased_features:[]},
    }},
    request:null,
  });
  const blueprints=buildBgamingExecutionBlueprints(p);
  assert.equal(blueprints.length,1);
  assert.equal(blueprints[0].wire_protocol,'jsonrpc-2.0');
  assert.equal(blueprints[0].request_template.method,'play');
  assert.equal(blueprints[0].request_template.params.req.bet,'<BET_SUBUNITS>');
  assert.equal(blueprints[0].request_template.params.req.bet_type,'bet');
});

test('detects BGaming init responses whose schema is not mapped yet', () => {
  const events=[
    {
      seq:1,type:'request',requestId:'u1',method:'POST',
      url:'https://demo.bgaming-network.com/api/OldGame/1/session',
      postData:JSON.stringify({command:'init',extra_data:{round_series_id:1}}),
    },
    {
      seq:2,type:'responsebody',requestId:'u1',
      url:'https://demo.bgaming-network.com/api/OldGame/1/session',
      body:JSON.stringify({wallet:100000,game:0}),
    },
  ];
  const start=extractBgamingUnrecognizedInit(events);
  assert.ok(start);
  assert.deepEqual(start.body,{wallet:100000,game:0});
});


test('models AllLuckyClover launcher as four fixed-line wire variants', () => {
  const p=summarizeBgamingAllLuckyCloverLauncher();
  assert.equal(p.generation,'legacy-fixed-lines');
  assert.deepEqual(p.launcher.line_choices,[5,20,40,100]);
  assert.equal(p.line_variants.length,4);
  assert.deepEqual(p.line_variants[0].display_bets,[0.1,0.2,0.3,0.4,0.5,1,1.5,2,3,5,10]);
  assert.deepEqual(p.line_variants[3].raw_bets,[50,100,150,200,250,300,350,400,450,500,1500,2500]);
  assert.equal(bgamingNeedsReview(p),false);

  const blueprints=buildBgamingExecutionBlueprints(p);
  assert.equal(blueprints.length,4);
  assert.equal(blueprints[0].endpoint_game,'AllLuckyClover5');
  assert.deepEqual(blueprints[0].request_template.options,{bet:'<BET_SUBUNITS>'});
  assert.equal(blueprints[3].lines,100);

  const catalog=bgamingCatalog(p);
  assert.equal(catalog.line_variants.length,4);
});


test('JSONRPC unresolved catalog mode does not invent a request template', () => {
  const p=summarizeBgamingJsonRpcInit({
    body:{jsonrpc:'2.0',result:{
      currency_attributes:{code:'FUN',subunits:100},
      config:{bet_limits:[20,100],default_bet:20,purchased_features:['buy_bonus']},
    }},
    request:null,
  }, {
    source:'client_static_buy_bonus_costs',
    catalog_complete:true,
    wire_complete:false,
    request_shape:[],
    evidence_urls:['https://game/assets/main.js'],
    modes:[{
      kind:'buy',
      feature:'buy_bonus',
      id:'deep_spin',
      level:'deep_spin',
      multiplier:100,
      request_fields:null,
      wire_complete:false,
      wire_requirements:['game_specific_buy_bonus_wire'],
      source:'client_static_buy_bonus_costs',
    }],
  });
  const blueprints=buildBgamingExecutionBlueprints(p);
  assert.equal(blueprints.length,2);
  assert.equal(blueprints[1].request_template,null);
  assert.equal(blueprints[1].unresolved_reason,'JSONRPC_WIRE_REQUIRES_GAME_CONTEXT');
});


test('prefers complete BGaming JSONRPC init over earlier partial init', () => {
  const events=[
    {
      seq:1,type:'request',requestId:'p1',method:'POST',
      url:'https://game.demo.bgaming-network.com/api',
      postData:JSON.stringify({jsonrpc:'2.0',method:'init',id:'partial',params:{token:'t'}}),
    },
    {
      seq:2,type:'responsebody',requestId:'p1',
      url:'https://game.demo.bgaming-network.com/api',
      body:JSON.stringify({jsonrpc:'2.0',id:'partial',result:{
        config:{bet_limits:[]},
      }}),
    },
    {
      seq:3,type:'request',requestId:'p2',method:'POST',
      url:'https://game.demo.bgaming-network.com/api',
      postData:JSON.stringify({jsonrpc:'2.0',method:'init',id:'full',params:{token:'t'}}),
    },
    {
      seq:4,type:'responsebody',requestId:'p2',
      url:'https://game.demo.bgaming-network.com/api',
      body:JSON.stringify({jsonrpc:'2.0',id:'full',result:{
        balance:100000,
        currency_attributes:{code:'FUN',subunits:100},
        config:{
          bet_limits:[20,100,500],
          default_bet:100,
          purchased_features:['buy_bonus'],
        },
      }}),
    },
  ];
  const start=extractBgamingJsonRpcInit(events);
  assert.ok(start);
  assert.equal(JSON.parse(start.request.postData).id,'full');
  assert.deepEqual(start.body.result.config.bet_limits,[20,100,500]);
});
