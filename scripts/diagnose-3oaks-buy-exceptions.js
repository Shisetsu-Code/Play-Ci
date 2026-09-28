import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractThreeOaksStart, classifyThreeOaksPlay } from '../src/providers/three-oaks.js';

const cases=[
  {name:'ratpack-direct-mode',family:'ratpack',url:'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en',arg:1,prep:'none'},
  {name:'ratpack-testactions-mode',family:'ratpack',url:'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en',arg:1,prep:'none',testActions:true},
  {name:'kendoo-mode',family:'kendoo',url:'https://3oaks.com/api/v1/games/3_coin_volcanoes/play?lang=en',arg:1,prep:'click'},
  {name:'kendoo-index',family:'kendoo',url:'https://3oaks.com/api/v1/games/3_coin_volcanoes/play?lang=en',arg:0,prep:'click'},
  {name:'kendoo-direct-mode',family:'kendoo',url:'https://3oaks.com/api/v1/games/3_coin_volcanoes/play?lang=en',arg:1,prep:'none'},
  {name:'kendoo-direct-index',family:'kendoo',url:'https://3oaks.com/api/v1/games/3_coin_volcanoes/play?lang=en',arg:0,prep:'none'},
];
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const service=new BrowserService(config);

async function dismiss(page){
  const m=await page.evaluate(()=>{
    try{
      const fn=window.TestActions?.closeStartScreen;
      if(typeof fn==='function'){
        const s=Function.prototype.toString.call(fn).replace(/\s+/g,'');
        if(!/\{\}$/.test(s)){fn.call(window.TestActions);return 'TestActions.closeStartScreen';}
      }
    }catch{}
    try{if(typeof window.app?.startScreen?.skip==='function'){window.app.startScreen.skip();return 'app.startScreen.skip';}}catch{}
    return null;
  }).catch(()=>null);
  if(!m) await page.mouse.click(config.viewport.width/2,config.viewport.height-50);
  await sleep(1600);
  return m||'viewport_click';
}

async function inspect(page){
 return page.evaluate(()=>{
   const src=(fn)=>{try{return Function.prototype.toString.call(fn).slice(0,3000)}catch{return null}};
   const desc=(obj)=>{
     if(!obj)return null;
     const names=[...new Set([...Object.getOwnPropertyNames(obj),...Object.getOwnPropertyNames(Object.getPrototypeOf(obj)||{})])];
     const functions={};
     const values={};
     for(const k of names){
       let v;try{v=obj[k]}catch{continue;}
       if(typeof v==='function') functions[k]=src(v);
       else if(v==null||['string','number','boolean'].includes(typeof v)) values[k]=v;
     }
     return {functions,values,keys:names};
   };
   return {
     testActions:desc(window.TestActions),
     boardBuy:desc(window.app?.board?.buyFeature),
     boardPopup:desc(window.app?.board?.buyFeaturePopup),
     appBuy:desc(window.app?.buyFeature),
     appBuyController:desc(window.app?.buyFeature?.controller),
     grBuy:desc(window.GR?.UI?.view?.buy_feature),
     uiModelBuyFeature: (()=>{try{return window.GR?.UI?.model?.get?.('buy_feature')??null}catch{return null}})(),
   };
 });
}

async function one(c){
 const s=await service.createSession({url:c.url,skipSplash:false,captureInitialScreenshot:false});
 const internal=service.sessions.get(s.id);
 try{
   const start=extractThreeOaksStart(internal.recorder.eventsAfter(0));
   const dismissal=await dismiss(internal.page);
   await sleep(400);
   const shape=await inspect(internal.page);

   let prep={};
   if(c.prep==='click'){
     prep=await internal.page.evaluate(()=>{
       const v=window.GR?.UI?.view?.buy_feature;
       try{
         if(typeof v?.click==='function'){
           const result=v.click();
           return {called:true,resultType:typeof result,visible:v.visible?.(),disabled:v.disabled?.()};
         }
       }catch(e){return {called:false,error:e.message};}
       return {called:false};
     });
     await sleep(700);
   }

   const marker=internal.recorder.marker();
   const invocation=await internal.page.evaluate(({arg,testActions})=>{
     try{
       if(testActions){
         const fn=window.TestActions?.playBuyFeature;
         if(typeof fn!=='function')return {ok:false,error:'TA missing'};
         fn.call(window.TestActions,arg);
         return {ok:true,hook:'TestActions.playBuyFeature',arg};
       }
       const owner=window.app?.board?.buyFeature;
       const fn=owner?.actBuyFeature;
       if(typeof fn!=='function')return {ok:false,error:'direct missing'};
       fn.call(owner,arg);
       return {ok:true,hook:'app.board.buyFeature.actBuyFeature',arg};
     }catch(e){return {ok:false,error:e.message};}
   },{arg:c.arg,testActions:Boolean(c.testActions)});

   await internal.recorder.waitForActivityAfter(marker,{timeoutMs:6000});
   await internal.recorder.waitForQuiet({quietMs:600,timeoutMs:9000});
   const plays=classifyThreeOaksPlay(internal.recorder.eventsAfter(0),marker);
   return {
     ...c,dismissal,prep,invocation,
     start:{modes:start?.body?.context?.available_buy_bonus,prices:start?.body?.settings?.buy_bonus_prices},
     shape,
     plays:plays.map(p=>({request:p.request,http:p.http_status,status:p.response?.status,accepted:p.accepted}))
   };
 }finally{await service.closeSession(s.id);}
}

await service.start();
try{
 const results=[];
 for(const c of cases)results.push(await one(c));
 await fs.mkdir('artifacts/buy-exceptions',{recursive:true});
 await fs.writeFile('artifacts/buy-exceptions/results.json',JSON.stringify(results,null,2),'utf8');
 console.log(JSON.stringify(results.map(r=>({
  name:r.name,prep:r.prep,invocation:r.invocation,
  plays:r.plays
 })),null,2));
}finally{await service.stop();}
