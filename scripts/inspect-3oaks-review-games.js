import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractThreeOaksStart } from '../src/providers/three-oaks.js';

const targets=[
 {id:'3_jewel_crowns',url:'https://3oaks.com/api/v1/games/3_jewel_crowns/play?lang=en'},
 {id:'777_fruity_coins',url:'https://3oaks.com/api/v1/games/777_fruity_coins/play?lang=en'},
 {id:'buddha_megaways',url:'https://3oaks.com/api/v1/games/buddha_megaways/play?lang=en'},
 {id:'egypt_fire_2',url:'https://3oaks.com/api/v1/games/egypt_fire_2/play?lang=en'},
];

const service=new BrowserService(config);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function waitClient(page,timeout=15000){
 const end=Date.now()+timeout;
 while(Date.now()<end){
  const ok=await page.evaluate(()=>Boolean(window.app?.board||window.TestActions||window.GR?.UI)).catch(()=>false);
  if(ok)return true;
  await sleep(150);
 }
 return false;
}

async function dismiss(page){
 await page.evaluate(()=>{
  try{if(typeof window.TestActions?.closeStartScreen==='function'){window.TestActions.closeStartScreen();return;}}catch{}
  try{window.app?.startScreen?.skip?.();}catch{}
 }).catch(()=>{});
 await sleep(1400);
}

async function objectInfo(page,expr){
 return page.evaluate((expression)=>{
  let obj;try{obj=(0,eval)(expression)}catch{return null}
  if(!obj)return null;
  const src=(fn)=>{try{return Function.prototype.toString.call(fn).slice(0,2200)}catch{return null}};
  const own=Object.getOwnPropertyNames(obj);
  const proto=Object.getPrototypeOf(obj);
  const names=[...new Set([...own,...(proto?Object.getOwnPropertyNames(proto):[])])];
  const functions={};const values={};
  for(const n of names){
   let v;try{v=obj[n]}catch{continue}
   if(typeof v==='function'&&/buy|bonus|feature|option|price|cost|param|set|shop|tap|spin/i.test(n))functions[n]=src(v);
   else if(v==null||['string','number','boolean'].includes(typeof v))values[n]=v;
  }
  return {own,proto:proto?Object.getOwnPropertyNames(proto):[],functions,values};
 },expr);
}

async function one(t){
 const session=await service.createSession({url:t.url,skipSplash:false,captureInitialScreenshot:false});
 const internal=service.sessions.get(session.id);
 try{
  const start=extractThreeOaksStart(internal.recorder.eventsAfter(0));
  const body=start?.body||null;
  await waitClient(internal.page);
  await dismiss(internal.page);

  const marker=internal.recorder.marker();
  const openResult=await internal.page.evaluate(async()=>{
   try{
    const fn=window.TestActions?.openBuyFeaturePopup;
    if(typeof fn==='function'){
      const src=Function.prototype.toString.call(fn).replace(/\s+/g,'');
      if(!/\{\}$/.test(src)){fn.call(window.TestActions);await new Promise(r=>setTimeout(r,700));return {ok:true,method:'TestActions'};}
    }
   }catch(e){return {ok:false,error:e.message}}
   try{
    const h=window.GR?.UI?.view?.buy_feature?.click?.();
    if(typeof h==='function'){h();await new Promise(r=>setTimeout(r,700));return {ok:true,method:'GR.UI.view.buy_feature.click handler'};}
   }catch(e){return {ok:false,error:e.message}}
   return {ok:false};
  }).catch(e=>({ok:false,error:e.message}));

  await internal.recorder.waitForQuiet({quietMs:400,timeoutMs:2500});

  const runtime=await internal.page.evaluate(()=>{
   const safe=(fn,...args)=>{try{return typeof fn==='function'?fn(...args):null}catch(e){return {error:e.message}}};
   const m=window.app?.model;
   const popup=window.app?.board?.buyFeaturePopup;
   const buyBonus=window.app?.board?.buyBonus || window.app?.buyBonus;
   const readItems=(arr)=>Array.isArray(arr)?arr.slice(0,20).map((item,index)=>{
     const obj=item||{};
     const picked={index,ctor:obj?.constructor?.name||null};
     for(const key of ['type','id','buyFeatureType','optionType','price','cost','multiplier','value','mode']){
       try{if(obj[key]!=null)picked[key]=obj[key]}catch{}
     }
     try{
      if(obj.button){
       picked.button={};
       for(const key of ['id','buyFeatureType','optionType','type']){
        if(obj.button[key]!=null)picked.button[key]=obj.button[key];
       }
      }
     }catch{}
     try{
      if(obj.config)picked.config=JSON.parse(JSON.stringify(obj.config));
     }catch{}
     return picked;
   }):null;

   return {
    getBuyOptionCount:safe(m?.getBuyOptionCount?.bind(m)),
    buyBonusCalculatedPrice:safe(m?.buyBonusCalculatedPrice?.bind(m)),
    buyBonusEnoughBalanceMap:safe(m?.buyBonusEnoughBalanceMap?.bind(m)),
    featureCost:safe(m?.featureCost?.bind(m)),
    roundBet:safe(m?.roundBet?.bind(m)),
    popup:{
      chosen:popup?._chosenOptionType??null,
      buyVariantsPool:readItems(popup?.buyVariantsPool),
      cardsList:readItems(popup?.cardsList),
      options:readItems(popup?.options),
      components:readItems(popup?.components),
    },
    gr:{
      buy_feature_cost:window.GR?.UI?.model?.get?.('buy_feature_cost')??null,
      buy_feature_text:window.GR?.UI?.model?.get?.('buy_feature_text')??null,
      booster_option:window.GR?.UI?.model?.get?.('booster_option')??null,
    },
    connector:(()=>{
      const c=window.app?.grShopButtonConnector;
      if(!c)return null;
      const out={};
      for(const k of ['visible','active','enabled','selected','price','cost','mode','option'])try{if(c[k]!=null)out[k]=c[k]}catch{}
      try{out.keys=Object.getOwnPropertyNames(c)}catch{}
      return out;
    })(),
   };
  }).catch(e=>({error:e.message}));

  const objects={};
  for(const expr of [
    'window.app?.model',
    'window.app?.board?.buyBonus',
    'window.app?.buyBonus',
    'window.app?.board?.buyFeature',
    'window.app?.board?.buyFeaturePopup',
    'window.app?.grShopButtonConnector',
    'window.GR?.UI?.Events',
  ])objects[expr]=await objectInfo(internal.page,expr);

  const events=internal.recorder.eventsAfter(marker).filter(e=>e.type==='request'&&e.method==='POST');

  return {
   ...t,
   start:{actions:body?.context?.actions||[],context:body?.context||null,settings:body?.settings||null,modes:body?.modes||null},
   openResult,
   runtime,
   objects,
   openRequests:events.map(e=>({url:e.url,postData:e.postData})),
  };
 }finally{await service.closeSession(session.id)}
}

await service.start();
try{
 const results=[];
 for(const t of targets)results.push(await one(t));
 await fs.mkdir('artifacts/review-games',{recursive:true});
 await fs.writeFile('artifacts/review-games/review-games.json',JSON.stringify(results,null,2),'utf8');
 console.log(JSON.stringify(results,null,2));
}finally{await service.stop()}
