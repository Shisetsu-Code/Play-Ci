import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractThreeOaksStart } from '../src/providers/three-oaks.js';

const target={id:'egypt_fire_2',url:'https://3oaks.com/api/v1/games/egypt_fire_2/play?lang=en'};
const service=new BrowserService(config);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function waitReady(page,timeout=20000){
  const end=Date.now()+timeout;
  let last=null;
  while(Date.now()<end){
    last=await page.evaluate(()=>{
      const m=window.GR?.UI?.model;
      const get=(k)=>{try{return m?.get?.(k)??null}catch{return null}};
      return {
        readyState:document.readyState,
        preloader_hidden:get('preloader_hidden'),
        game_gr_loaded:get('game_gr_loaded'),
        controls_available:get('controls.available'),
        actions:get('actions'),
        board:Boolean(window.app?.board),
      };
    }).catch(()=>null);
    if(last?.board && last?.preloader_hidden===true && Array.isArray(last?.actions) && last.actions.length){
      return {ready:true,state:last};
    }
    await sleep(200);
  }
  return {ready:false,state:last};
}

async function dismiss(page){
  const method=await page.evaluate(()=>{
    try{
      const fn=window.TestActions?.closeStartScreen;
      if(typeof fn==='function'){
        const src=Function.prototype.toString.call(fn).replace(/\s+/g,'');
        if(!/\{\}$/.test(src)){fn.call(window.TestActions);return 'TestActions.closeStartScreen';}
      }
    }catch{}
    try{
      if(typeof window.app?.startScreen?.skip==='function'){
        window.app.startScreen.skip();
        return 'app.startScreen.skip';
      }
    }catch{}
    return null;
  }).catch(()=>null);
  if(!method) await page.mouse.click(config.viewport.width/2,config.viewport.height-50);
  await sleep(1000);
  return method||'viewport_click';
}

async function inspectRuntime(page){
  return page.evaluate(()=>{
    const src=(fn)=>{try{return Function.prototype.toString.call(fn).slice(0,5000)}catch{return null}};
    const objects=[
      ['app',window.app],
      ['app.board',window.app?.board],
      ['app.model',window.app?.model],
      ['app.controllers',window.app?.controllers],
      ['GR.UI',window.GR?.UI],
      ['GR.UI.model',window.GR?.UI?.model],
      ['GR.UI.view',window.GR?.UI?.view],
      ['GR.UI.Events',window.GR?.UI?.Events],
    ];
    const out={};
    for(const [name,obj] of objects){
      if(!obj)continue;
      let names=[];
      try{
        names=[...new Set([
          ...Object.getOwnPropertyNames(obj),
          ...Object.getOwnPropertyNames(Object.getPrototypeOf(obj)||{})
        ])];
      }catch{}
      const functions={};
      const values={};
      for(const key of names){
        let value;
        try{value=obj[key]}catch{continue}
        if(typeof value==='function' && /param|setting|mode|bet|shop|option|spin|play|action|feature|jackpot|fake|collect/i.test(key)){
          functions[key]=src(value);
        }else if(/param|setting|mode|bet|shop|option|feature|jackpot/i.test(key)){
          if(value==null||['string','number','boolean'].includes(typeof value)) values[key]=value;
        }
      }
      out[name]={functions,values};
    }

    const m=window.GR?.UI?.model;
    const modelData={};
    try{
      for(const [k,v] of Object.entries(m?.data||{})){
        if(/param|setting|mode|bet|shop|option|feature|jackpot/i.test(k)){
          try{modelData[k]=structuredClone(v)}catch{modelData[k]=String(v)}
        }
      }
    }catch{}

    return {objects:out,modelData};
  });
}

async function searchBundles(internal){
  const urls=await internal.page.evaluate(()=>
    performance.getEntriesByType('resource')
      .map((e)=>e.name)
      .filter((u)=>/\.js(?:\?|$)/i.test(u))
  );

  const unique=[...new Set(urls)];
  const hits=[];

  for(const url of unique){
    let response;
    try{
      response=await internal.context.request.get(url,{failOnStatusCode:false,timeout:15000});
    }catch{continue}
    if(response.status()<200||response.status()>=300)continue;

    let text;
    try{text=await response.text()}catch{continue}
    if(text.length>8_000_000)continue;

    const patterns=['set_params','SET_PARAMS','setParams','set params'];
    for(const pattern of patterns){
      let from=0;
      while(true){
        const index=text.indexOf(pattern,from);
        if(index<0)break;
        hits.push({
          url,
          pattern,
          index,
          snippet:text.slice(Math.max(0,index-1800),Math.min(text.length,index+2600)),
        });
        from=index+pattern.length;
        if(hits.length>=40)return {resource_count:unique.length,hits};
      }
    }
  }

  return {resource_count:unique.length,hits};
}

await service.start();
try{
  const session=await service.createSession({url:target.url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  try{
    const start=extractThreeOaksStart(internal.recorder.eventsAfter(0));
    const dismissal=await dismiss(internal.page);
    const readiness=await waitReady(internal.page);
    const runtime=await inspectRuntime(internal.page);
    const bundles=await searchBundles(internal);

    const report={
      target,
      dismissal,
      readiness,
      start:{
        actions:start?.body?.context?.actions||[],
        context:start?.body?.context||null,
        settings:start?.body?.settings||null,
      },
      runtime,
      bundles,
    };

    await fs.mkdir('artifacts/review-games',{recursive:true});
    await fs.writeFile('artifacts/review-games/egypt-fire-2.json',JSON.stringify(report,null,2),'utf8');
    console.log(JSON.stringify({
      dismissal,
      readiness,
      actions:report.start.actions,
      bundle_resources:bundles.resource_count,
      set_params_hits:bundles.hits.map((h)=>({url:h.url,pattern:h.pattern,index:h.index,snippet:h.snippet})),
    },null,2));
  }finally{
    await service.closeSession(session.id);
  }
}finally{
  await service.stop();
}
