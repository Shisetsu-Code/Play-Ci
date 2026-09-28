import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractThreeOaksStart, classifyThreeOaksPlay } from '../src/providers/three-oaks.js';

const service=new BrowserService(config);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const url='https://3oaks.com/api/v1/games/3_coin_volcanoes/play?lang=en';

async function dismiss(page){
  const method=await page.evaluate(()=>{
    try{
      const fn=window.TestActions?.closeStartScreen;
      if(typeof fn==='function'){
        const src=Function.prototype.toString.call(fn).replace(/\s+/g,'');
        if(!/\{\}$/.test(src)){fn.call(window.TestActions);return 'TestActions.closeStartScreen';}
      }
    }catch{}
    try{if(typeof window.app?.startScreen?.skip==='function'){window.app.startScreen.skip();return 'app.startScreen.skip';}}catch{}
    return null;
  }).catch(()=>null);
  if(!method) await page.mouse.click(config.viewport.width/2,config.viewport.height-50);
  await sleep(1400);
  return method||'viewport_click';
}

async function runCase(name,prep,arg){
 const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
 const internal=service.sessions.get(s.id);
 try{
  const start=extractThreeOaksStart(internal.recorder.eventsAfter(0));
  await dismiss(internal.page);
  const before=await internal.page.evaluate(()=>({
    visible:(()=>{try{return window.GR?.UI?.view?.buy_feature?.visible?.()??null}catch{return null}})(),
    disabled:(()=>{try{return window.GR?.UI?.view?.buy_feature?.disabled?.()??null}catch{return null}})(),
    clickValue:(()=>{try{return window.GR?.UI?.view?.buy_feature?.click?.()??null}catch{return null}})(),
  }));
  const prepResult=await internal.page.evaluate(async(prep)=>{
    try{
      if(prep==='observable-object'){
        window.GR.UI.view.buy_feature.click({type:'pointertap',synthetic:true});
        return {ok:true,method:'GR.UI.view.buy_feature.click({})'};
      }
      if(prep==='observable-counter'){
        const current=window.GR.UI.view.buy_feature.click();
        window.GR.UI.view.buy_feature.click(typeof current==='number'?current+1:{tick:Date.now()});
        return {ok:true,method:'GR.UI.view.buy_feature.click(changed)'};
      }
      if(prep==='controller'){
        window.app.buyFeature.controller.emitOnTap();
        return {ok:true,method:'app.buyFeature.controller.emitOnTap'};
      }
      if(prep==='module-tap'){
        window.app.buyFeature.tap();
        return {ok:true,method:'app.buyFeature.tap'};
      }
      return {ok:true,method:'none'};
    }catch(e){return {ok:false,error:e.message,method:prep}}
  },prep);
  await sleep(700);
  const mid=await internal.page.evaluate(()=>({
    visible:(()=>{try{return window.GR?.UI?.view?.buy_feature?.visible?.()??null}catch{return null}})(),
    disabled:(()=>{try{return window.GR?.UI?.view?.buy_feature?.disabled?.()??null}catch{return null}})(),
    clickValue:(()=>{try{return window.GR?.UI?.view?.buy_feature?.click?.()??null}catch{return null}})(),
  }));
  const marker=internal.recorder.marker();
  const selection=await internal.page.evaluate((arg)=>{
    try{
      const fn=window.app?.board?.buyFeature?.actBuyFeature;
      if(typeof fn!=='function')return {ok:false,error:'missing'};
      fn.call(window.app.board.buyFeature,arg); return {ok:true,arg};
    }catch(e){return {ok:false,error:e.message,arg}}
  },arg);
  await internal.recorder.waitForActivityAfter(marker,{timeoutMs:5000});
  await internal.recorder.waitForQuiet({quietMs:500,timeoutMs:8000});
  const plays=classifyThreeOaksPlay(internal.recorder.eventsAfter(0),marker);
  return {name,prep,arg,before,prepResult,mid,selection,start:{modes:start?.body?.context?.available_buy_bonus,prices:start?.body?.settings?.buy_bonus_prices},plays:plays.map(p=>({request:p.request,http:p.http_status,status:p.response?.status,accepted:p.accepted}))};
 }finally{await service.closeSession(s.id)}
}

async function fairy(){
 const u='https://3oaks.com/api/v1/games/4_fairy_flowers/play?lang=en';
 const s=await service.createSession({url:u,skipSplash:false,captureInitialScreenshot:false});
 const internal=service.sessions.get(s.id);
 try{
  const start=extractThreeOaksStart(internal.recorder.eventsAfter(0));
  await dismiss(internal.page);
  return {
   start:start?.body||null,
   runtime:await internal.page.evaluate(()=>({
    direct:typeof window.app?.board?.buyFeature?.actBuyFeature==='function',
    test:typeof window.TestActions?.playBuyFeature==='function',
    visible:(()=>{try{return window.GR?.UI?.view?.buy_feature?.visible?.()??null}catch{return null}})(),
    disabled:(()=>{try{return window.GR?.UI?.view?.buy_feature?.disabled?.()??null}catch{return null}})(),
   }))
  };
 }finally{await service.closeSession(s.id)}
}

await service.start();
try{
 const cases=[
  await runCase('object-mode','observable-object',1),
  await runCase('counter-mode','observable-counter',1),
  await runCase('controller-mode','controller',1),
  await runCase('module-tap-mode','module-tap',1),
  await runCase('object-index','observable-object',0),
  await runCase('controller-index','controller',0),
 ];
 const report={cases,fairy:await fairy()};
 await fs.mkdir('artifacts/kendoo-fairy',{recursive:true});
 await fs.writeFile('artifacts/kendoo-fairy/report.json',JSON.stringify(report,null,2),'utf8');
 console.log(JSON.stringify({
  cases:cases.map(c=>({name:c.name,before:c.before,prep:c.prepResult,mid:c.mid,plays:c.plays})),
  fairy:{actions:report.fairy.start?.context?.actions,modes:report.fairy.start?.context?.available_buy_bonus,prices:report.fairy.start?.settings?.buy_bonus_prices,buyPrice:report.fairy.start?.settings?.buy_bonus_price,fixed:report.fairy.start?.settings?.freespins_buying_price,runtime:report.fairy.runtime}
 },null,2));
}finally{await service.stop()}
