import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const cases=[
  ['kendoo-1-0','3_hot_chillies'],
  ['kendoo-2-0','3_lucky_sparks'],
  ['kendoo-3-0','3_coin_volcanoes'],
];

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const service=new BrowserService(config);

async function state(page){
  return page.evaluate(()=>({
    readyState:document.readyState,
    preloader:(()=>{try{return window.GR?.UI?.model?.get?.('preloader_hidden')??null}catch{return null}})(),
    controls:(()=>{try{return window.GR?.UI?.model?.get?.('controls.available')??null}catch{return null}})(),
    buyVisible:(()=>{try{return window.GR?.UI?.view?.buy_feature?.visible?.()??null}catch{return null}})(),
    buyDisabled:(()=>{try{return window.GR?.UI?.view?.buy_feature?.disabled?.()??null}catch{return null}})(),
    buySelected:(()=>{try{return window.GR?.UI?.view?.buy_feature?.selected?.()??null}catch{return null}})(),
    appBuyActive:window.app?.buyFeature?.active??null,
    appBuyVisible:window.app?.buyFeature?.visible??null,
    appBuyX:window.app?.buyFeature?.x??null,
    appBuyY:window.app?.buyFeature?.y??null,
    viewX:(()=>{try{return window.GR?.UI?.view?.buy_feature?.x?.()??null}catch{return null}})(),
    viewY:(()=>{try{return window.GR?.UI?.view?.buy_feature?.y?.()??null}catch{return null}})(),
    board:Boolean(window.app?.board),
  }));
}

async function waitUntil(page,predicate,timeout=45000){
  const start=Date.now(); let last=null;
  while(Date.now()-start<timeout){
    last=await state(page).catch(()=>null);
    if(last&&predicate(last)) return {ok:true,waited:Date.now()-start,state:last};
    await sleep(200);
  }
  return {ok:false,waited:Date.now()-start,state:last};
}

async function scanInteractive(page){
  return page.evaluate(()=>{
    const out=[];
    const roots=[window.app?.stage,window.app?.board,window.app?.buyFeature].filter(Boolean);
    const seen=new WeakSet();
    const walk=(obj,depth=0)=>{
      if(!obj||depth>12||(typeof obj!=='object'&&typeof obj!=='function')||seen.has(obj))return;
      seen.add(obj);
      let bounds=null;
      try{const b=obj.getBounds?.(); if(b)bounds={x:b.x,y:b.y,width:b.width,height:b.height};}catch{}
      const interactive=Boolean(obj.interactive)||['static','dynamic'].includes(obj.eventMode);
      if(obj.visible!==false&&interactive&&bounds&&bounds.width>5&&bounds.height>5&&bounds.x<1280&&bounds.y<720&&bounds.x+bounds.width>0&&bounds.y+bounds.height>0){
        out.push({ctor:obj.constructor?.name||null,name:obj.name||null,label:obj.label||null,eventMode:obj.eventMode||null,interactive:Boolean(obj.interactive),bounds});
      }
      for(const child of obj.children||[])walk(child,depth+1);
    };
    for(const root of roots)walk(root);
    return out;
  });
}

await service.start();
try{
  const manifest=[];
  for(const [id,game] of cases){
    const url=`https://3oaks.com/api/v1/games/${game}/play?lang=en`;
    const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
    const internal=service.sessions.get(s.id);
    const dir=path.join('artifacts','kendoo-popups',id);
    await fs.mkdir(dir,{recursive:true});
    try{
      const loaded=await waitUntil(internal.page,s=>s.preloader===true||s.controls===true,45000);
      const startShot=await service.capture(s.id,'start-ready');
      await fs.copyFile(path.resolve(startShot.path),path.join(dir,'start-ready.png'));

      // Kendoo start screens are canvas/WebGL and require a real pointer gesture.
      await internal.page.mouse.click(640,650);
      await sleep(1000);
      const entered=await waitUntil(
        internal.page,
        s=>s.controls===true || s.appBuyActive===true || (s.buyVisible===true&&s.buyDisabled===false),
        30000,
      );
      const gameShot=await service.capture(s.id,'game-ready');
      await fs.copyFile(path.resolve(gameShot.path),path.join(dir,'game-ready.png'));

      const before=await state(internal.page);
      const interactiveBefore=await scanInteractive(internal.page);
      await fs.writeFile(path.join(dir,'interactive-before.json'),JSON.stringify(interactiveBefore,null,2),'utf8');

      // Prefer the actual visible BUY FEATURE control. If model coordinates are not
      // usable, click the center of the most plausible interactive rectangle.
      let open=null;
      if(Number.isFinite(Number(before.viewX))&&Number.isFinite(Number(before.viewY))&&before.viewX>=0&&before.viewX<1280&&before.viewY>=0&&before.viewY<720){
        await internal.page.mouse.click(Number(before.viewX),Number(before.viewY));
        open={method:'view_xy',x:Number(before.viewX),y:Number(before.viewY)};
      }else{
        const plausible=interactiveBefore
          .filter(x=>x.bounds.width>=60&&x.bounds.height>=25&&x.bounds.width<500&&x.bounds.height<250)
          .sort((a,b)=>a.bounds.x-b.bounds.x)[0];
        if(plausible){
          const x=plausible.bounds.x+plausible.bounds.width/2;
          const y=plausible.bounds.y+plausible.bounds.height/2;
          await internal.page.mouse.click(x,y);
          open={method:'interactive',x,y,bounds:plausible.bounds};
        }
      }
      await sleep(1200);
      const popup=await service.capture(s.id,'popup');
      await fs.copyFile(path.resolve(popup.path),path.join(dir,'popup.png'));
      const interactiveAfter=await scanInteractive(internal.page);
      await fs.writeFile(path.join(dir,'interactive-after.json'),JSON.stringify(interactiveAfter,null,2),'utf8');

      manifest.push({id,game,url,loaded,entered,before,open,interactiveBefore,interactiveAfter,ok:true});
    }catch(error){manifest.push({id,game,url,ok:false,error:error.message});}
    finally{await service.closeSession(s.id);}
  }
  await fs.writeFile('artifacts/kendoo-popups/manifest.json',JSON.stringify(manifest,null,2),'utf8');
}finally{await service.stop();}
