import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const games=[
  'YommiRush',
  'SugarMix',
  'BigBucksSaloon',
  'BlackbeardsBounty',
  'JewelBoom',
  'StarTrekNextGen',
  'ZeusGoesWild',
  'ChickenFire',
];
const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

await service.start();
try{
  const manifest=[];
  for(const game of games){
    const url=`https://demo.bgaming-network.com/play/${game}/FUN`;
    const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
    const internal=service.sessions.get(s.id);
    const dir=path.join('artifacts','bg-jsonrpc-ui',game);
    await fs.mkdir(dir,{recursive:true});
    try{
      await sleep(7500);
      const ready=await service.capture(s.id,'ready');
      await fs.copyFile(path.resolve(ready.path),path.join(dir,'ready.png'));

      // Conservative startup sequence observed across the current JSON-RPC samples.
      for(const [x,y,wait] of [
        [640,650,1800],
        [640,615,1500],
        [1140,650,1800],
      ]){
        await internal.page.mouse.click(x,y);
        await sleep(wait);
      }

      const shot=await service.capture(s.id,'game');
      await fs.copyFile(path.resolve(shot.path),path.join(dir,'game.png'));
      const state=await internal.page.evaluate(()=>({
        final_url:location.href,
        readyState:document.readyState,
        title:document.title,
        canvases:[...document.querySelectorAll('canvas')].map(c=>({
          width:c.width,
          height:c.height,
          rect:{
            x:c.getBoundingClientRect().x,
            y:c.getBoundingClientRect().y,
            width:c.getBoundingClientRect().width,
            height:c.getBoundingClientRect().height,
          },
        })),
        text:document.body?.innerText?.slice(0,2500)||'',
      }));
      await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(state,null,2),'utf8');
      manifest.push({game,url,ok:true,state});
    }catch(error){
      manifest.push({game,url,ok:false,error:error.message});
    }finally{
      await service.closeSession(s.id);
      await sleep(250);
    }
  }
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(manifest,null,2),'utf8');
  console.log(JSON.stringify(manifest.map(x=>({
    game:x.game,
    ok:x.ok,
    final_url:x.state?.final_url||null,
    canvas_count:x.state?.canvases?.length||0,
    error:x.error||null,
  })),null,2));
}finally{
  await service.stop();
}
