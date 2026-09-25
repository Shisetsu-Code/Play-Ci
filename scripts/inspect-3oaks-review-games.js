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

async function inspectObj(page,expr){
  return page.evaluate((expression)=>{
    let obj;try{obj=(0,eval)(expression);}catch{return null;}
    if(!obj)return null;
    const src=(fn)=>{try{return Function.prototype.toString.call(fn).slice(0,1800)}catch{return null}};
    const own=Object.getOwnPropertyNames(obj);
    const proto=Object.getPrototypeOf(obj);
    const names=[...new Set([...own,...(proto?Object.getOwnPropertyNames(proto):[])])];
    const functions={};const values={};
    for(const n of names){
      let v;try{v=obj[n]}catch{continue;}
      if(typeof v==='function'){
        if(/buy|bonus|feature|spin|param|line|bet|option|select|set|open|close|show|hide/i.test(n))functions[n]=src(v);
      }else if(v==null||['string','number','boolean'].includes(typeof v)){
        if(/buy|bonus|feature|spin|param|line|bet|option|select|mode|price|cost/i.test(n))values[n]=v;
      }
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
    await internal.page.evaluate(()=>{
      try{if(typeof window.TestActions?.closeStartScreen==='function'){window.TestActions.closeStartScreen();return;}}catch{}
      try{window.app?.startScreen?.skip?.();}catch{}
    }).catch(()=>{});
    await sleep(1400);

    if(body?.context?.actions?.includes('buy_spin')){
      await internal.page.evaluate(async()=>{
        try{
          if(typeof window.TestActions?.openBuyFeaturePopup==='function'){
            window.TestActions.openBuyFeaturePopup();
            await new Promise(r=>setTimeout(r,500));
          }
        }catch{}
      }).catch(()=>{});
    }

    const exprs=[
      'window.TestActions',
      'window.app',
      'window.app?.model',
      'window.app?.board',
      'window.app?.board?.buyFeature',
      'window.app?.board?.buyFeaturePopup',
      'window.app?.board?.bonusShopPopup',
      'window.app?.buyFeature',
      'window.GR?.UI?.model',
      'window.GR?.UI?.view?.buy_feature',
    ];
    const objects={};
    for(const e of exprs)objects[e]=await inspectObj(internal.page,e);

    const deep=await internal.page.evaluate(()=>{
      const serialize=(obj,depth=0,seen=new WeakSet())=>{
        if(obj==null||['string','number','boolean'].includes(typeof obj))return obj;
        if(typeof obj==='function')return '[function]';
        if(typeof obj!=='object'||depth>2)return '[object]';
        if(seen.has(obj))return '[circular]';seen.add(obj);
        if(Array.isArray(obj))return obj.slice(0,20).map(v=>serialize(v,depth+1,seen));
        const out={};
        let keys=[];try{keys=Object.getOwnPropertyNames(obj)}catch{return '[unreadable]'};
        for(const k of keys){
          if(!/buy|bonus|feature|option|mode|price|cost|param|line|bet|component|config|setting/i.test(k))continue;
          try{out[k]=serialize(obj[k],depth+1,seen)}catch{}
        }
        return out;
      };
      return {
        buyFeature:serialize(window.app?.board?.buyFeature),
        buyFeaturePopup:serialize(window.app?.board?.buyFeaturePopup),
        appBuyFeature:serialize(window.app?.buyFeature),
        model:serialize(window.app?.model),
        grModel:serialize(window.GR?.UI?.model),
      };
    }).catch(()=>null);

    return {
      ...t,
      start:{
        actions:body?.context?.actions||[],
        context:body?.context||null,
        settings:body?.settings||null,
        modes:body?.modes||null,
      },
      objects,
      deep,
    };
  }finally{await service.closeSession(session.id);}
}

await service.start();
try{
 const results=[];
 for(const t of targets)results.push(await one(t));
 await fs.mkdir('artifacts/review-games',{recursive:true});
 await fs.writeFile('artifacts/review-games/review-games.json',JSON.stringify(results,null,2),'utf8');
 console.log(JSON.stringify(results,null,2));
}finally{await service.stop();}
