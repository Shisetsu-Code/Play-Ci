import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractBgamingJsonRpcInit } from '../src/providers/bgaming.js';

const games=[
  'AztecsClawWildDice','BigBucksSaloon','BlackbeardsBounty','BlazingFirepots',
  'BlingBlitzDiamondDrop','CatsLoveYummy','ChickenFire','ClashofGodsAnubisvsHades',
  'CluckingHell','GrandPatron7rst','HotRocket532','JewelBoom','JokerVsJoker',
  'JungleQueen','KeepersOfTheSecret7rst','MultiRush','MysticReels','RecycleRiches',
  'RedHotChilliChickens','RocketEruptionTripleBlast','StarTrekNextGen','SugarMix',
  'SweetSamurai','GatesOfPower','TheGodfather3PillarsOfPower','TreasureExplorer',
  'WildClustersP','YommiRush','ZeusGoesWild',
];

const service=new BrowserService({
  ...config,
  maxBodyBytes:12*1024*1024,
  maxMemoryEvents:40000,
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function waitInit(internal,timeout=12000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const init=extractBgamingJsonRpcInit(internal.recorder.eventsAfter(0));
    if(init)return init;
    await sleep(150);
  }
  return null;
}

function uniq(rows,keyFn){
  const seen=new Set();
  return rows.filter(row=>{
    const key=keyFn(row);
    if(seen.has(key))return false;
    seen.add(key);
    return true;
  });
}

function extractObjects(text){
  const rows=[];
  const needles=['purchaseFeature:','purchasedFeature:','feature_id:','buy_id:','bonus_buy:','custom_field:','machineId:','buy_feature_id:','bonus_multiplier_type:'];
  for(const needle of needles){
    let from=0;
    while(true){
      const at=text.indexOf(needle,from);
      if(at<0)break;
      const window=text.slice(Math.max(0,at-1600),Math.min(text.length,at+2200));
      const ids=[...window.matchAll(/(?:^|[,\{])id:["']([^"']+)["']/g)].map(m=>m[1]);
      const prices=[...window.matchAll(/(?:^|[,\{])price:([0-9]+(?:\.[0-9]+)?)/g)].map(m=>Number(m[1]));
      const purchased=[...window.matchAll(/(?:purchaseFeature|purchasedFeature):["']([^"']+)["']/g)].map(m=>m[1]);
      const stringPairs=[...window.matchAll(/(buy_id|feature_id|buy_feature_id|bonus_buy|custom_field|machineId|bonus_multiplier_type):["']([^"']+)["']/g)]
        .map(m=>({key:m[1],value:m[2]}));
      rows.push({
        needle,
        ids:[...new Set(ids)].slice(0,20),
        prices:[...new Set(prices)].slice(0,20),
        purchased:[...new Set(purchased)].slice(0,20),
        string_pairs:uniq(stringPairs,x=>x.key+'='+x.value).slice(0,30),
        snippet:window.replace(/\s+/g,' ').slice(0,3600),
      });
      from=at+needle.length;
      if(rows.length>300)break;
    }
    if(rows.length>300)break;
  }
  return uniq(rows,row=>JSON.stringify([row.needle,row.ids,row.prices,row.purchased,row.string_pairs]));
}

function extractPriceMaps(text){
  const rows=[];
  const re=/\{((?:[A-Za-z_$][\w$]*:[0-9]+(?:\.[0-9]+)?\s*,\s*){1,15}[A-Za-z_$][\w$]*:[0-9]+(?:\.[0-9]+)?)\}/g;
  for(const match of text.matchAll(re)){
    const entries={};
    for(const pair of match[1].split(',')){
      const [key,value]=pair.split(':').map(x=>x.trim());
      if(!key||!Number.isFinite(Number(value)))continue;
      if(/buy|bonus|boost|super|ultra|chance|spin|feature/i.test(key))entries[key]=Number(value);
    }
    if(Object.keys(entries).length)rows.push(entries);
    if(rows.length>=30)break;
  }
  return uniq(rows,row=>JSON.stringify(row));
}

function extractRequestShapes(text){
  const keys=['buy_id','feature_id','buy_feature_id','bonus_buy','custom_field','machineId','bonus_multiplier_type','instant_bonus_game','ante_bet','wild_bet','modelRev','minExponent'];
  return keys.filter(key=>new RegExp('(?:req|const\\s+\\w+)\\s*[:=]?[^;]{0,500}'+key+'|'+key+'\\s*:', 'i').test(text));
}

async function inspect(game){
  const url='https://demo.bgaming-network.com/play/'+game+'/FUN';
  const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  try{
    const init=await waitInit(internal);
    await internal.recorder.waitForQuiet({quietMs:450,timeoutMs:3000}).catch(()=>{});
    const events=internal.recorder.eventsAfter(0);
    const sources=[];
    for(const event of events){
      if(event.type!=='responsebody'||typeof event.body!=='string'||event.body.length<500)continue;
      if(!/\.(?:js|mjs)(?:\?|$)/i.test(event.url||''))continue;
      if(!/purchased_feature|purchaseFeature|buy_id|feature_id|bonus_buy|custom_field|machineId|buy_feature_id|bonus_multiplier_type|instant_bonus_game/i.test(event.body))continue;
      const objects=extractObjects(event.body);
      const price_maps=extractPriceMaps(event.body);
      const request_shape=extractRequestShapes(event.body);
      if(objects.length||price_maps.length||request_shape.length){
        sources.push({
          url:event.url,
          bytes:Buffer.byteLength(event.body),
          request_shape,
          price_maps,
          objects:objects.slice(0,80),
        });
      }
    }
    return {
      game,
      ok:Boolean(init),
      endpoint:init?.request?.url||null,
      purchased_features:init?.body?.result?.config?.purchased_features||[],
      sources:sources.slice(0,20),
    };
  }catch(error){
    return {game,ok:false,error:error.message,sources:[]};
  }finally{
    await service.closeSession(session.id);
  }
}

async function pool(items,limit,fn){
  const out=new Array(items.length);
  let cursor=0;
  async function worker(){
    while(true){
      const i=cursor++;
      if(i>=items.length)return;
      out[i]=await fn(items[i]);
      await sleep(200);
    }
  }
  await Promise.all(Array.from({length:limit},worker));
  return out;
}

await service.start();
try{
  const results=await pool(games,4,inspect);
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/static-feature-profiles.json',JSON.stringify(results,null,2),'utf8');
  const summary=results.map(row=>({
    game:row.game,
    ok:row.ok,
    purchased_features:row.purchased_features,
    request_shapes:[...new Set(row.sources.flatMap(s=>s.request_shape))],
    price_maps:row.sources.flatMap(s=>s.price_maps).slice(0,12),
    candidate_objects:row.sources.flatMap(s=>s.objects).filter(o=>
      o.ids.length||o.prices.length||o.purchased.length||o.string_pairs.length
    ).slice(0,18),
    error:row.error||null,
  }));
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(summary,null,2),'utf8');
  console.log(JSON.stringify(summary,null,2));
}finally{
  await service.stop();
}
