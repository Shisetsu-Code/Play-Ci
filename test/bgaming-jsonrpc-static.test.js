import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBgamingJsonRpcStaticProfile,
} from '../src/providers/bgaming-jsonrpc-static.js';
import {
  summarizeBgamingJsonRpcInit,
  bgamingNeedsReview,
  buildBgamingExecutionBlueprints,
} from '../src/providers/bgaming.js';

function jsEvent(body, url='https://game.demo.bgaming-network.com/assets/main.js') {
  return {type:'responsebody', url, body};
}

test('extracts constant-backed shop modes and buy_id wire shape', () => {
  const source = [
    'const Qd=90,Yd=2,_a="boost",Ny="cx64";',
    'function modes(){return[',
    '{id:_a,price:Yd,purchaseFeature:"buy_chance",activation:!0},',
    '{id:Ny,price:Qd,purchaseFeature:"buy_bonus_and_chance",activation:!0},',
    '{id:"bonus",price:100,purchaseFeature:"buy_bonus",activation:!1},',
    '{id:"super",price:400,purchaseFeature:"buy_bonus",activation:!1}',
    ']}',
    'async play(t,e,i){const n={bet:t,purchased_feature:e,buy_id:i};return n}',
  ].join('');

  const profile=extractBgamingJsonRpcStaticProfile([jsEvent(source)]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,true);
  assert.deepEqual(profile.request_shape,['buy_id']);
  assert.deepEqual(
    profile.modes.map(x=>[x.id,x.feature,x.multiplier,x.request_fields.buy_id]),
    [
      ['boost','buy_chance',2,'boost'],
      ['cx64','buy_bonus_and_chance',90,'cx64'],
      ['bonus','buy_bonus',100,'bonus'],
      ['super','buy_bonus',400,'super'],
    ],
  );
});

test('extracts wrapper purchaseFeaturesConfig even when replay needs requestData', () => {
  const source = [
    'purchaseFeaturesConfig:[',
    '{id:"chance",type:"buy_chance",configFeatureType:"buy_chance",betPriceMultiplier:2},',
    '{id:"buy_random",type:"buy_bonus",configFeatureType:"buy_bonus",price:100},',
    '{id:"buy_max",type:"buy_bonus",configFeatureType:"buy_bonus",price:300}',
    '],',
    'sendPlay(e){const{bet:t,requestData:n,feature:i,betType:s}=e;',
    'return this.sendAction("play",{req:Object.assign({},n,{bet:t,bet_type:s,custom_field:i?.id,purchased_feature:i?.type})})}',
  ].join('');

  const profile=extractBgamingJsonRpcStaticProfile([jsEvent(source)]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,false);
  assert.deepEqual(
    profile.modes.map(x=>[x.id,x.feature,x.multiplier]),
    [
      ['chance','buy_chance',2],
      ['buy_random','buy_bonus',100],
      ['buy_max','buy_bonus',300],
    ],
  );
  assert.deepEqual(profile.modes[0].wire_requirements,['requestData','bet_type']);
});

test('extracts ChickenFire feature_id price map and chance multiplier', () => {
  const source = [
    'const JP=1.5,QP={buy_bonus:60,buy_super_bonus:90,buy_ultra_bonus:120};',
    'const ZP=t=>t.purchased_feature?t.bet*((t,e)=>{',
    'if("buy_chance"===t)return JP;',
    'if("buy_bonus"===t){if(!e)throw new Error();return QP[e]}return 1',
    '})(t.purchased_feature,t.feature_id):t.bet;',
    'function send(t,e,i){return {req:{bet:t,bet_type:"bet",purchased_feature:e,feature_id:i}}}',
  ].join('');

  const profile=extractBgamingJsonRpcStaticProfile([jsEvent(source)]);
  assert.equal(profile.catalog_complete,true);
  assert.deepEqual(
    profile.modes.map(x=>[x.id,x.feature,x.multiplier]),
    [
      ['buy_chance','buy_chance',1.5],
      ['buy_bonus','buy_bonus',60],
      ['buy_super_bonus','buy_bonus',90],
      ['buy_ultra_bonus','buy_bonus',120],
    ],
  );
});

test('extracts TreasureExplorer machine profile', () => {
  const source = [
    'const prices={buy_chance:1.4,buy_bonus:100,buy_bonus_and_chance:250};',
    'jo.init({currency:"USD",gameId:"TreasureHunt",machineId:"6"});',
    'function buy(e){return {req:{bet:e.params.bet,machineId:parseInt(e.params.machineId,10),purchased_feature:e.params.feature}}}',
  ].join('');

  const profile=extractBgamingJsonRpcStaticProfile([jsEvent(source)]);
  assert.equal(profile.catalog_complete,true);
  assert.deepEqual(profile.request_shape,['machineId']);
  assert.deepEqual(
    profile.modes.map(x=>[x.feature,x.multiplier,x.request_fields.machineId]),
    [
      ['buy_chance',1.4,6],
      ['buy_bonus',100,6],
      ['buy_bonus_and_chance',250,6],
    ],
  );
});

test('static JSONRPC catalog removes unresolved capability review and builds mode blueprints', () => {
  const profile={
    source:'client_static_shop',
    catalog_complete:true,
    wire_complete:true,
    request_shape:['buy_id'],
    evidence_urls:['https://game/assets/main.js'],
    modes:[{
      kind:'buy',
      feature:'buy_bonus',
      id:'bonus',
      level:'bonus',
      multiplier:100,
      request_fields:{purchased_feature:'buy_bonus',buy_id:'bonus'},
      wire_complete:true,
      source:'client_static_shop',
    }],
  };
  const protocol=summarizeBgamingJsonRpcInit({
    body:{jsonrpc:'2.0',result:{
      currency_attributes:{code:'FUN',subunits:100},
      config:{
        bet_limits:[10,100],
        default_bet:100,
        purchased_features:['buy_bonus','bonus_buy','buy_chance'],
      },
    }},
    request:null,
  }, profile);

  assert.equal(bgamingNeedsReview(protocol),false);
  assert.equal(protocol.special_modes.length,1);
  const blueprints=buildBgamingExecutionBlueprints(protocol);
  assert.equal(blueprints.length,2);
  assert.equal(blueprints[1].request_template.params.req.buy_id,'bonus');
  assert.equal(blueprints[1].request_template.params.req.purchased_feature,'buy_bonus');
});
