import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const games=[
  'BigBucksSaloon',
  'BlackbeardsBounty',
  'JewelBoom',
  'StarTrekNextGen',
  'ZeusGoesWild',
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
      for(const [x,y,wait] of [
        [640,650,1800],
        [640,615,1500],
        [1140,650,1800],
      ]){
        await internal.page.mouse.click(x,y);
        await sleep(wait);
      }
      const shot=await service.capture(s.id,'final');
      await fs.copyFile(path.resolve(shot.path),path.join(dir,'final.png'));
      manifest.push({game,url,ok:true});
    }catch(error){
      manifest.push({game,url,ok:false,error:error.message});
    }finally{
      await service.closeSession(s.id);
      await sleep(250);
    }
  }
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(manifest,null,2),'utf8');
  console.log(JSON.stringify(manifest,null,2));
}finally{
  await service.stop();
}
