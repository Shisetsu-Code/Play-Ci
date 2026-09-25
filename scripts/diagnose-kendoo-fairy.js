import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractThreeOaksStart, classifyThreeOaksPlay } from '../src/providers/three-oaks.js';

const service=new BrowserService(config);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

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
  await sleep(1500);
  return method||'viewport_click';
}

async function describe(page){
  return page.evaluate(()=>{
    const src=(fn)=>{try{return Function.prototype.toString.call(fn).slice(0,4000)}catch{return null}};
    const walk=(obj,prefix)=>{
      const rows=[];
      if(!obj)return rows;
      let names=[];try{names=[...new Set([...Object.getOwnPropertyNames(obj),...Object.getOwnPropertyNames(Object.getPrototypeOf(obj)||{})])]}catch{}
      for(const k of names){
        if(!/buy|feature|confirm|accept|popup|option|shop|bonus|tap|click|play/i.test(k))continue;
        let v;try{v=obj[k]}catch{continue}
        rows.push({
          path:prefix+'.'+k,type:typeof v,
          value:(v==null||['string','number','boolean'].includes(typeof v))?v:undefined,
          ctor:v?.constructor?.name||null,
          source:typeof v==='function'?src(v):null,
          keys:(v&&(typeof v==='object'||typeof v==='function'))?(()=>{try{return Object.getOwnPropertyNames(v).slice(0,80)}catch{return []}})():[]
        });
      }
      return rows;
    };
    const objects=[
      [window.TestActions,'TestActions'],[window.app,'app'],[window.app?.board,'app.board'],
      [window.app?.buyFeature,'app.buyFeature'],[window.app?.buyFeature?.controller,'app.buyFeature.controller'],
      [window.app?.board?.buyFeature,'app.board.buyFeature'],[window.app?.board?.buyFeaturePopup,'app.board.buyFeaturePopup'],
      [window.GR?.UI?.view,'GR.UI.view'],[window.GR?.UI?.model,'GR.UI.model'],[window.GR?.UI?.Events,'GR.UI.Events'],
    ];
    const rows=objects.flatMap(([o,p])=>walk(o,p));
    const model={}; const m=window.GR?.UI?.model;
    for(const key of ['buy_feature','buy_feature_options','buy_feature_option','buy_feature_visible','buy_feature_enabled','actions','controls.available']){
      try{model[key]=m?.get?.(key)??null}catch{}
    }
    return {rows,model};
  });
}

async function inspectKendoo(){
  const url='https://3oaks.com/api/v1/games/3_coin_volcanoes/play?lang=en';
  const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(s.id);
  try{
    const start=extractThreeOaksStart(internal.recorder.eventsAfter(0));
    await dismiss(internal.page);
    const before=await describe(internal.page);
    const marker=internal.recorder.marker();
    const select=await internal.page.evaluate(()=>{
      try{
        const fn=window.app?.board?.buyFeature?.actBuyFeature;
        if(typeof fn!=='function')return {ok:false,error:'missing'};
        fn.call(window.app.board.buyFeature,1); return {ok:true};
      }catch(e){return {ok:false,error:e.message}}
    });
    await sleep(800);
    const after=await describe(internal.page);
    const screenshot=await service.capture(s.id,'kendoo-after-select');
    const plays=classifyThreeOaksPlay(internal.recorder.eventsAfter(0),marker);

    const jsUrls=await internal.page.evaluate(()=>[...new Set(performance.getEntriesByType('resource').map(e=>e.name).filter(u=>/\.js(?:\?|$)/i.test(u)))]);
    const hits=[];
    for(const jsUrl of jsUrls){
      let res;try{res=await internal.context.request.get(jsUrl,{failOnStatusCode:false,timeout:15000})}catch{continue}
      if(res.status()<200||res.status()>=300)continue;
      let text;try{text=await res.text()}catch{continue}
      if(text.length>10_000_000)continue;
      for(const pattern of ['BUY_FEATURE_ACTIONS','actBuyFeature','action:"buy"','buy_feature']){
        let pos=0,n=0;
        while((pos=text.indexOf(pattern,pos))>=0&&n<8){
          hits.push({url:jsUrl,pattern,index:pos,snippet:text.slice(Math.max(0,pos-1800),Math.min(text.length,pos+3000))});
          pos+=pattern.length;n++;
        }
      }
    }
    return {url,start:{context:start?.body?.context,settings:start?.body?.settings},select,before,after,plays,screenshot,hits:hits.slice(0,80)};
  }finally{await service.closeSession(s.id)}
}

async function inspectFairy(){
  const url='https://3oaks.com/api/v1/games/4_fairy_flowers/play?lang=en';
  const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(s.id);
  try{
    const start=extractThreeOaksStart(internal.recorder.eventsAfter(0));
    await dismiss(internal.page); await sleep(700);
    const runtime=await describe(internal.page);
    const screenshot=await service.capture(s.id,'fairy-runtime');
    return {
      url,start:start?.body||null,runtime,screenshot,
      buyCapability:await internal.page.evaluate(()=>({
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
  const report={kendoo:await inspectKendoo(),fairy:await inspectFairy()};
  await fs.mkdir('artifacts/kendoo-fairy',{recursive:true});
  await fs.writeFile('artifacts/kendoo-fairy/report.json',JSON.stringify(report,null,2),'utf8');
  console.log(JSON.stringify({
    kendoo:{select:report.kendoo.select,plays:report.kendoo.plays,modelBefore:report.kendoo.before.model,modelAfter:report.kendoo.after.model,hitCount:report.kendoo.hits.length},
    fairy:{actions:report.fairy.start?.context?.actions,buyModes:report.fairy.start?.context?.available_buy_bonus,buyPrices:report.fairy.start?.settings?.buy_bonus_prices,buyPrice:report.fairy.start?.settings?.buy_bonus_price,fixed:report.fairy.start?.settings?.freespins_buying_price,buyCapability:report.fairy.buyCapability}
  },null,2));
}finally{await service.stop()}
