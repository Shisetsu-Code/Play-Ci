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

async function dismiss(page){
  const method=await page.evaluate(()=>{
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
  if(!method) await page.mouse.click(640,360);
  await sleep(1800);
  return method||'viewport_click';
}

async function openBuy(page){
  const state=await page.evaluate(()=>{
    const v=window.GR?.UI?.view?.buy_feature;
    const read=(name)=>{try{return typeof v?.[name]==='function'?v[name]():v?.[name]??null}catch{return null}};
    return {
      x:Number(read('x')),
      y:Number(read('y')),
      visible:read('visible'),
      disabled:read('disabled'),
    };
  });
  if(Number.isFinite(state.x)&&Number.isFinite(state.y)&&state.x>=0&&state.x<1280&&state.y>=0&&state.y<720){
    await page.mouse.click(state.x,state.y);
    await sleep(1200);
    return {method:'GR.UI.view.buy_feature.xy',...state};
  }
  // Kendoo common lower-left fallback.
  await page.mouse.click(150,195);
  await sleep(1200);
  return {method:'fallback',...state};
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
      await sleep(5000);
      const dismissal=await dismiss(internal.page);
      const base=await service.capture(s.id,'base');
      await fs.copyFile(path.resolve(base.path),path.join(dir,'base.png'));
      const open=await openBuy(internal.page);
      const popup=await service.capture(s.id,'popup');
      await fs.copyFile(path.resolve(popup.path),path.join(dir,'popup.png'));
      const tree=await internal.page.evaluate(()=>{
        const out=[];
        const root=window.app?.stage||window.app?.board;
        const walk=(obj,depth=0)=>{
          if(!obj||depth>8)return;
          let bounds=null;
          try{const b=obj.getBounds?.(); if(b)bounds={x:b.x,y:b.y,width:b.width,height:b.height};}catch{}
          const interactive=Boolean(obj.interactive)||['static','dynamic'].includes(obj.eventMode);
          if(obj.visible!==false&&interactive&&bounds&&bounds.width>5&&bounds.height>5&&bounds.x<1280&&bounds.y<720&&bounds.x+bounds.width>0&&bounds.y+bounds.height>0){
            out.push({ctor:obj.constructor?.name||null,name:obj.name||null,label:obj.label||null,eventMode:obj.eventMode||null,interactive:Boolean(obj.interactive),bounds});
          }
          for(const child of obj.children||[])walk(child,depth+1);
        };
        walk(root);
        return out;
      });
      await fs.writeFile(path.join(dir,'interactive.json'),JSON.stringify(tree,null,2),'utf8');
      manifest.push({id,game,url,dismissal,open,interactive:tree,ok:true});
    }catch(error){manifest.push({id,game,url,ok:false,error:error.message});}
    finally{await service.closeSession(s.id);}
  }
  await fs.writeFile('artifacts/kendoo-popups/manifest.json',JSON.stringify(manifest,null,2),'utf8');
}finally{await service.stop();}
