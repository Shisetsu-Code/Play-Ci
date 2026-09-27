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

function jsonEvent(value, url='https://game.demo.bgaming-network.com/gameConfig.json') {
  return {type:'responsebody', url, body:JSON.stringify(value)};
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


test('extracts JSON buyFeatureInfo configs with buy_feature_id wire', () => {
  const profile=extractBgamingJsonRpcStaticProfile([
    jsonEvent({
      buyFeatureInfo:{
        configs:[
          {buyFeatureId:1,purchasedFeature:'buy_bonus',pricePercent:10000},
        ],
      },
      featureOnOff:{buyFeature:true},
    }),
  ]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,true);
  assert.deepEqual(profile.request_shape,['buy_feature_id']);
  assert.deepEqual(
    profile.modes.map(x=>[x.feature,x.id,x.multiplier,x.request_fields.buy_feature_id]),
    [['buy_bonus','1',100,1]],
  );
});

test('extracts engine definition normal/super buy costs as a complete catalog', () => {
  const profile=extractBgamingJsonRpcStaticProfile([
    jsonEvent({
      engine:{definition:{normalBuyCost:100,superBuyCost:200}},
    }, 'https://game.demo.bgaming-network.com/definitions.json'),
  ]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,false);
  assert.deepEqual(
    profile.modes.map(x=>[x.id,x.multiplier]),
    [['normal',100],['super',200]],
  );
});

test('extracts engine definition freespin/respin buy multipliers', () => {
  const profile=extractBgamingJsonRpcStaticProfile([
    jsonEvent({
      engine:{definition:{featureBuyMulFreespin:75,featureBuyMulRespin:30}},
    }, 'https://game.demo.bgaming-network.com/definitions.json'),
  ]);
  assert.equal(profile.catalog_complete,true);
  assert.deepEqual(
    profile.modes.map(x=>[x.id,x.multiplier]),
    [['freespin',75],['respin',30]],
  );
});

test('extracts bonus multiplier purchase family with chance', () => {
  const source = [
    'const e=state,t=100*e.bet,n=200*e.bet;',
    'const cfg={goldenBetMulti:1.5};',
    'async function a(){return play({bet:e.bet,purchased_feature:"buy_bonus",bonus_multiplier_type:"freeSpin"})}',
    'async function b(){return play({bet:e.bet,purchased_feature:"buy_bonus",bonus_multiplier_type:"freeSpinRandom"})}',
    'async function c(){return play({bet:e.bet,purchased_feature:e.buyChance?"buy_chance":void 0,bet_type:"bet"})}',
  ].join('');
  const profile=extractBgamingJsonRpcStaticProfile([jsEvent(source)]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,true);
  assert.deepEqual(
    profile.modes.map(x=>[x.id,x.multiplier]),
    [['buy_chance',1.5],['freeSpin',100],['freeSpinRandom',200]],
  );
});


test('extracts Yommi feature multiplier and purchased-feature mappings', () => {
  const source = [
    'const s={FEATURES:{MORE_PETS:"MORE_PETS",BONUS:"BONUS",SUPER_BONUS:"SUPER_BONUS"}};',
    'x.FEATURE_BET_MULTIPLIER=assign(assign(assign({},s.FEATURES.BONUS,100n),s.FEATURES.SUPER_BONUS,250n),s.FEATURES.MORE_PETS,3n);',
    'x.PURCHASED_FEATURES=assign(assign(assign({},s.FEATURES.MORE_PETS,"buy_chance"),s.FEATURES.BONUS,"buy_bonus"),s.FEATURES.SUPER_BONUS,"buy_bonus_and_chance");',
    'function play(){return {req:{bet:20,bet_type:"bet",purchased_feature:"buy_bonus",modelRev:0,minExponent:2}}}',
  ].join('');
  const profile=extractBgamingJsonRpcStaticProfile([jsEvent(source)]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,true);
  assert.deepEqual(
    profile.modes.map(x=>[x.feature,x.multiplier]),
    [['buy_chance',3],['buy_bonus',100],['buy_bonus_and_chance',250]],
  );
  assert.equal(profile.modes[0].request_fields.modelRev,0);
  assert.equal(profile.modes[0].request_fields.minExponent,2);
});

test('extracts single buy mode from client fsMultiplier', () => {
  const source = [
    'class B{constructor(){this.fsMultiplier=50}}',
    'machineInfo.purchasedFeatures.some((e=>"buy_bonus"==e));',
    'function send(){return {bet:100,bet_type:"default",purchased_feature:"buy_bonus"}}',
  ].join('');
  const profile=extractBgamingJsonRpcStaticProfile([jsEvent(source)]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,true);
  assert.deepEqual(
    profile.modes.map(x=>[x.feature,x.multiplier,x.request_fields.bet_type]),
    [['buy_bonus',50,'default']],
  );
});


test('extracts BigBucks single buy multiplier', () => {
  const source=[
    'class S{init(){this.buyBonusMultiplier=0}initBalance(t){this.buyBonusMultiplier=120}}',
    'updateBonusPrice(){data.bonusPrices.freespin_buy=data.bet*this.buyBonusMultiplier}',
    'buyBonus(){this.spin(!0,{purchased_feature:"buy_bonus"})}',
  ].join('');
  const profile=extractBgamingJsonRpcStaticProfile([jsEvent(source)]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,true);
  assert.deepEqual(profile.modes.map(x=>[x.feature,x.multiplier]),[['buy_bonus',120]]);
});

test('extracts BlazingFirepots chance and bonus prices', () => {
  const source=[
    'updateBonusPrice(){const{wager:t}=state,e=formatMoney(100*t)}',
    'setWager(t){this.value.text=formatCurrency(this.isAnteSpinActive?1.4*t:t)}',
    'const a={method:"play",params:{req:{bet:Math.round(g*y),bet_type:"betting",purchased_feature:"buy_chance"}}};',
    'const b={method:"play",params:{req:{bet:Math.round(g*y),bet_type:"betting",purchased_feature:"buy_bonus"}}};',
  ].join('');
  const profile=extractBgamingJsonRpcStaticProfile([jsEvent(source)]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,true);
  assert.deepEqual(
    profile.modes.map(x=>[x.feature,x.multiplier,x.request_fields.bet_type]),
    [['buy_chance',1.4,'betting'],['buy_bonus',100,'betting']],
  );
});

test('extracts SweetSamurai buy catalog without inventing wire', () => {
  const source=[
    'e("BUY_BONUS_COSTS",{DEEP_SPIN:100,DEEP_BONANZA:150});',
    'e("BonusType",function(e){return e.DEEP_SPIN="deep_spin",e.DEEP_BONANZA="deep_bonanza",e}({}));',
  ].join('');
  const profile=extractBgamingJsonRpcStaticProfile([jsEvent(source)]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,false);
  assert.deepEqual(profile.modes.map(x=>[x.id,x.multiplier]),[['deep_spin',100],['deep_bonanza',150]]);
  assert.equal(profile.modes[0].request_fields,null);
});


test('extracts MysticReels respin and bonus-buy wager transforms', () => {
  const source=[
    'function convertClientModeNameToPlatformName(gameMode){switch(gameMode){',
    'case "RESPIN_BUY": return "buy_chance";',
    'case "BONUS_BUY": return "buy_bonus";}}',
    'function addMetaDataToSpinRequest(request){',
    'if(this._inEncore){request.bet=(request.bet*2)/3;request.purchased_feature=this.convertClientModeNameToPlatformName("RESPIN_BUY")}',
    'else if(this._inBuyABonus){request.bet/=100;request.purchased_feature=this.convertClientModeNameToPlatformName("BONUS_BUY")}}',
  ].join('');
  const profile=extractBgamingJsonRpcStaticProfile([jsEvent(source)]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,true);
  assert.deepEqual(
    profile.modes.map(x=>[x.id,x.feature,x.multiplier,x.request_fields.bet]),
    [
      ['respin_buy','buy_chance',1.5,'<BASE_BET_SUBUNITS>'],
      ['bonus_buy','buy_bonus',100,'<BASE_BET_SUBUNITS>'],
    ],
  );
});

test('extracts Clash of Gods ante and bonus-buy feature map', () => {
  const source=[
    'function E(t){t.ante_0="ante_0",t.ante_1="ante_1",t.ante_2="ante_2"}',
    'function B(t){t.buy_bonus="buy_bonus",t.super_buy_bonus="super_buy_bonus"}',
    'class G{constructor(){this.buyBonusModeMultiplier1=100,this.buyBonusModeMultiplier2=300,this.businessmanModeMultiplier1=3,this.businessmanModeMultiplier2=10,this.businessmanModeMultiplier3=800}}',
    'network.invoke("play",{req:{bet:i,bet_type:n,fe_exponent:x,feature_buy:e,purchased_feature:r,bonus_type:y,buyBonusModeMultiplier:o}})',
  ].join('');
  const profile=extractBgamingJsonRpcStaticProfile([jsEvent(source)]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,true);
  assert.deepEqual(
    profile.modes.map(x=>[x.id,x.feature,x.multiplier]),
    [
      ['ante_1','buy_chance',3],
      ['ante_0','buy_chance',10],
      ['ante_2','buy_chance',800],
      ['buy_bonus','buy_bonus',100],
      ['super_buy_bonus','buy_bonus',300],
    ],
  );
  assert.equal(profile.modes[4].request_fields.buyBonusModeMultiplier,300);
});


test('extracts RedHotChilliChickens normal and super bonus buys', () => {
  const source=[
    'const historical=s&&"bonus_buy"===s.purchased_feature?e*(s.isSuperBonus?200:100):e;',
    'const req={bet:100,bet_type:"betting",isSuperBonus:false,purchased_feature:"bonus_buy"};',
  ].join('');
  const profile=extractBgamingJsonRpcStaticProfile([jsEvent(source)]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,true);
  assert.deepEqual(
    profile.modes.map(x=>[x.id,x.multiplier,x.request_fields.isSuperBonus]),
    [['bonus_buy',100,false],['super_bonus_buy',200,true]],
  );
  assert.equal(profile.modes[0].request_fields.bet_type,'betting');
});


test('extracts JokerVsJoker businessman and buy-bonus modes', () => {
  const source=[
    'class G{constructor(){this.businessmanMode=!1,this.busnesssmanModeMultiplier=10,this.buyBonusModeMultiplier=60}}',
    'function spin(e){e=e||(global.businessmanMode?"buy_chance":null);let n="default",r=1;"buy_bonus"==e&&(r=global.buyBonusModeMultiplier);',
    'return network.invoke("play",{req:{bet:100,bet_type:n,fe_exponent:global.feBetExponent,purchased_feature:e,balance:global.balance,buyBonusModeMultiplier:r}})}',
  ].join('');
  const profile=extractBgamingJsonRpcStaticProfile([jsEvent(source)]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,true);
  assert.deepEqual(
    profile.modes.map(x=>[x.id,x.feature,x.multiplier]),
    [['businessman_mode','buy_chance',10],['buy_bonus','buy_bonus',60]],
  );
  assert.equal(profile.modes[0].request_fields.buyBonusModeMultiplier,1);
  assert.equal(profile.modes[1].request_fields.buyBonusModeMultiplier,60);
});


test('extracts JungleQueen fixed buy-bonus wire and multiplier', () => {
  const source=[
    'let ua=100;',
    'function buy(){const n="buybonus",s="buybonus";return fetch("/api",{body:JSON.stringify({method:"play",params:{req:{bet:100,action:n,id:s,purchased_feature:"buy_bonus"}}})})}',
  ].join('');
  const profile=extractBgamingJsonRpcStaticProfile([jsEvent(source)]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,true);
  assert.deepEqual(
    profile.modes.map(x=>[x.id,x.feature,x.multiplier]),
    [['buybonus','buy_bonus',100]],
  );
  assert.equal(profile.modes[0].request_fields.action,'buybonus');
  assert.equal(profile.modes[0].request_fields.id,'buybonus');
});

test('treats client buy_btn false as a complete zero-purchase catalog', () => {
  const profile=extractBgamingJsonRpcStaticProfile([
    jsonEvent({bg_gaming:{buy_btn:'false'}}, 'https://game.demo.bgaming-network.com/slot_parameters.json'),
  ]);
  assert.equal(profile.catalog_complete,true);
  assert.equal(profile.wire_complete,true);
  assert.deepEqual(profile.modes,[]);
  assert.equal(profile.source,'client_json_buy_disabled');
});
