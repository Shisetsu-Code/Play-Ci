import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractThreeOaksStart } from '../src/providers/three-oaks.js';

const target={id:'egypt_fire_2',url:'https://3oaks.com/api/v1/games/egypt_fire_2/play?lang=en'};
const service=new BrowserService(config);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function waitClient(page,timeout=15000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    const state=await page.evaluate(()=>({
      app:Boolean(window.app),
      board:Boolean(window.app?.board),
      ui:Boolean(window.GR?.UI),
      shopHandler:typeof window.GR?.UI?.view?.shop_button?.click==='function',
    })).catch(()=>null);
    if(state?.board&&state?.ui&&state?.shopHandler)return state;
    await sleep(150);
  }
  return null;
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
    try{if(typeof window.app?.startScreen?.skip==='function'){window.app.startScreen.skip();return 'app.startScreen.skip';}}catch{}
    return null;
  }).catch(()=>null);
  if(!method)await page.mouse.click(config.viewport.width/2,config.viewport.height-50);
  await sleep(2200);
  return method||'viewport_click';
}

async function inspectObject(page,expr){
  return page.evaluate((expression)=>{
    let obj;try{obj=(0,eval)(expression)}catch{return null}
    if(!obj)return null;
    const src=(fn)=>{try{return Function.prototype.toString.call(fn).slice(0,3000)}catch{return null}};
    let own=[];let proto=[];
    try{own=Object.getOwnPropertyNames(obj)}catch{}
    try{proto=Object.getOwnPropertyNames(Object.getPrototypeOf(obj)||{})}catch{}
    const names=[...new Set([...own,...proto])];
    const functions={};const values={};
    for(const n of names){
      let v;try{v=obj[n]}catch{continue}
      if(typeof v==='function'&&/param|shop|option|bet|feature|spin|select|set|click|tap|show|open|confirm|apply|mode/i.test(n)){
        functions[n]=src(v);
      }else if(v==null||['string','number','boolean'].includes(typeof v)){
        values[n]=v;
      }
    }
    return {ctor:obj?.constructor?.name||null,own,proto,functions,values};
  },expr);
}

await service.start();
try{
  const session=await service.createSession({url:target.url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  try{
    const start=extractThreeOaksStart(internal.recorder.eventsAfter(0));
    const body=start?.body||null;
    const ready=await waitClient(internal.page);
    const dismissal=await dismiss(internal.page);

    const beforeMarker=internal.recorder.marker();
    const beforeState=await internal.page.evaluate(()=>{
      const model=window.GR?.UI?.model;
      return {
        model_data:model?.data??null,
        shop_button:{
          visible:model?.get?.('shop_button.visible')??null,
          enabled:model?.get?.('shop_button.enabled')??null,
        },
        actions:model?.get?.('actions')??null,
        controls_available:model?.get?.('controls.available')??null,
        preloader_hidden:model?.get?.('preloader_hidden')??null,
      };
    }).catch(e=>({error:e.message}));

    const openResult=await internal.page.evaluate(async()=>{
      try{
        const accessor=window.GR?.UI?.view?.shop_button?.click;
        if(typeof accessor!=='function')return {ok:false,error:'shop accessor missing'};
        const handler=accessor();
        if(typeof handler!=='function')return {ok:false,error:'shop handler missing',handlerType:typeof handler};
        const result=handler();
        if(result?.then)await Promise.race([result,new Promise(r=>setTimeout(r,1000))]);
        return {ok:true,resultType:typeof result};
      }catch(e){return {ok:false,error:e.message}}
    });
    await sleep(1200);

    const screenshot=await service.capture(session.id,'egypt-fire-2-shop');

    const expressions=[
      'window.app',
      'window.app?.board',
      'window.app?.model',
      'window.app?.grShopButtonConnector',
      'window.GR?.UI',
      'window.GR?.UI?.model',
      'window.GR?.UI?.view',
      'window.GR?.UI?.view?.shop_button',
      'window.GR?.UI?.view?.popup',
      'window.GR?.UI?.view?.custom_button',
      'window.GR?.UI?.view?.ante_bet',
      'window.GR?.UI?.view?.booster',
      'window.GR?.UI?.Events',
    ];
    const objects={};
    for(const expr of expressions)objects[expr]=await inspectObject(internal.page,expr);

    const afterState=await internal.page.evaluate(()=>{
      const model=window.GR?.UI?.model;
      const data=model?.data||{};
      const filtered={};
      for(const [k,v] of Object.entries(data)){
        if(/param|shop|option|feature|bet|mode|select|popup|control/i.test(k)){
          try{filtered[k]=structuredClone(v)}catch{filtered[k]=String(v)}
        }
      }

      const scan=(root,prefix,depth=0,seen=new WeakSet())=>{
        const out=[];
        if(!root||(typeof root!=='object'&&typeof root!=='function')||depth>3)return out;
        if(seen.has(root))return out;seen.add(root);
        let keys=[];try{keys=Object.getOwnPropertyNames(root)}catch{return out}
        for(const key of keys){
          if(!/param|shop|option|feature|bet|mode|select|popup/i.test(key))continue;
          let value;try{value=root[key]}catch{continue}
          const row={path:`${prefix}.${key}`,type:typeof value,ctor:value?.constructor?.name||null};
          if(value==null||['string','number','boolean'].includes(typeof value))row.value=value;
          else if(Array.isArray(value))row.array=value.slice(0,20).map((x)=>x&&typeof x==='object'?{ctor:x.constructor?.name||null,keys:Object.getOwnPropertyNames(x).slice(0,50)}:x);
          else{try{row.keys=Object.getOwnPropertyNames(value).slice(0,80)}catch{}}
          out.push(row);
        }
        return out;
      };

      return {
        filtered_model_data:filtered,
        scan:[
          ...scan(window.app,'app'),
          ...scan(window.app?.board,'app.board'),
          ...scan(window.GR?.UI?.view,'GR.UI.view'),
          ...scan(window.GR?.UI?.model,'GR.UI.model'),
        ],
      };
    }).catch(e=>({error:e.message}));

    await internal.recorder.waitForQuiet({quietMs:400,timeoutMs:2500});
    const network=internal.recorder.eventsAfter(beforeMarker)
      .filter(e=>['request','response','responsebody'].includes(e.type))
      .map(e=>({
        seq:e.seq,type:e.type,requestId:e.requestId,url:e.url,method:e.method,status:e.status,postData:e.postData,
        body:e.type==='responsebody'&&e.body?.length<20000?e.body:undefined,
      }));

    const report={target,ready,dismissal,start:{
      actions:body?.context?.actions||[],
      context:body?.context||null,
      settings:body?.settings||null,
    },beforeState,openResult,screenshot,objects,afterState,network};

    await fs.mkdir('artifacts/review-games',{recursive:true});
    await fs.writeFile('artifacts/review-games/egypt-fire-2.json',JSON.stringify(report,null,2),'utf8');
    console.log(JSON.stringify({ready,dismissal,openResult,screenshot,afterState,network},null,2));
  }finally{await service.closeSession(session.id)}
}finally{await service.stop()}
