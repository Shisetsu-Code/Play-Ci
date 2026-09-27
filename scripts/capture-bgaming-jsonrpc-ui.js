import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const cases=[
  {game:'BlingBlitzDiamondDrop', intro:[[820,380,900],[640,575,2500]]},
  {game:'HotRocket532', intro:[[820,380,900],[640,575,2500]]},
  {game:'JewelBoom', intro:[[820,380,900],[640,575,2500]]},
  {game:'ZeusGoesWild', intro:[[820,380,900],[640,575,2500]]},
];
const service=new BrowserService({...config,maxBodyBytes:10*1024*1024,maxMemoryEvents:30000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function state(page){
  return page.evaluate(()=>({
    url:location.href,
    title:document.title,
    bodyText:(document.body?.innerText||'').replace(/\s+/g,' ').trim().slice(0,3000),
    canvases:[...document.querySelectorAll('canvas')].map(c=>{
      const r=c.getBoundingClientRect();
      return {width:c.width,height:c.height,rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
    }),
  })).catch(error=>({error:error.message}));
}

await service.start();
try{
  const manifest=[];
  for(const item of cases){
    const url=`https://demo.bgaming-network.com/play/${item.game}/FUN?server=demo`;
    const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
    const internal=service.sessions.get(session.id);
    const dir=path.join('artifacts','bg-jsonrpc-ui',item.game);
    await fs.mkdir(dir,{recursive:true});
    try{
      await sleep(7500);
      let shot=await service.capture(session.id,'00-ready');
      await fs.copyFile(path.resolve(shot.path),path.join(dir,'00-ready.png'));

      for(const [x,y,wait] of item.intro){
        await internal.page.mouse.click(x,y).catch(()=>{});
        await sleep(wait);
      }
      await sleep(2000);
      shot=await service.capture(session.id,'01-main');
      await fs.copyFile(path.resolve(shot.path),path.join(dir,'01-main.png'));

      // Capture one extra state after closing common intro/modal areas without wagering.
      for(const [x,y,wait] of [[640,575,1000],[640,360,1000]]){
        await internal.page.mouse.click(x,y).catch(()=>{});
        await sleep(wait);
      }
      shot=await service.capture(session.id,'02-settled');
      await fs.copyFile(path.resolve(shot.path),path.join(dir,'02-settled.png'));

      const events=internal.recorder.eventsAfter(0);
      const purchaseMarkers=[];
      for(const e of events){
        if(e.type!=='responsebody'||typeof e.body!=='string')continue;
        if(!/\.(?:js|mjs|json)(?:\?|$)/i.test(e.url||''))continue;
        const body=e.body;
        const markers=[
          'purchased_feature','buy_bonus','buy_chance','buy_bonus_and_chance',
          'featureBuyMulFreespin','featureBuyMulRespin','purchaseFeaturesConfig',
          'buyFeatureId','buy_feature_id','buy_id','bonus_buy'
        ].filter(k=>body.includes(k));
        if(markers.length)purchaseMarkers.push({url:e.url,markers});
      }

      manifest.push({
        game:item.game,url,ok:true,
        page_state:await state(internal.page),
        purchase_marker_sources:purchaseMarkers.slice(0,30),
      });
    }catch(error){
      manifest.push({game:item.game,url,ok:false,error:error.message});
    }finally{
      await service.closeSession(session.id).catch(()=>{});
      await sleep(300);
    }
  }
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(manifest,null,2),'utf8');
  console.log(JSON.stringify(manifest.map(x=>({
    game:x.game,ok:x.ok,page_state:x.page_state,
    purchase_marker_sources:x.purchase_marker_sources,error:x.error||null,
  })),null,2));
}finally{await service.stop()}
