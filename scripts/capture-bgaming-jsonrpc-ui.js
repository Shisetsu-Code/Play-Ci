import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const cases=[
  {
    game:'YommiRush',
    steps:[[1140,650,1800],[260,390,900]],
    label:'buy-menu',
  },
  {
    game:'SugarMix',
    steps:[[640,650,1800],[640,615,1500],[200,390,900]],
    label:'buy-menu',
  },
  {
    game:'BigBucksSaloon',
    steps:[[100,560,1200]],
    label:'buy-menu',
  },
  {
    game:'BlingBlitzDiamondDrop',
    steps:[[825,365,1500],[640,665,1800]],
    label:'game',
  },
  {
    game:'JewelBoom',
    steps:[[825,365,1500],[640,665,1800]],
    label:'game',
  },
  {
    game:'HotRocket532',
    steps:[[825,365,1500],[640,665,1800]],
    label:'game',
  },
];

const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

await service.start();
try{
  const manifest=[];
  for(const item of cases){
    const url=`https://demo.bgaming-network.com/play/${item.game}/FUN`;
    const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
    const internal=service.sessions.get(session.id);
    const dir=path.join('artifacts','bg-jsonrpc-ui',item.game);
    await fs.mkdir(dir,{recursive:true});
    try{
      await sleep(7800);
      const before=await service.capture(session.id,'before');
      await fs.copyFile(path.resolve(before.path),path.join(dir,'00-before.png'));
      for(const [x,y,wait] of item.steps){
        await internal.page.mouse.click(x,y);
        await sleep(wait);
      }
      const after=await service.capture(session.id,item.label);
      await fs.copyFile(path.resolve(after.path),path.join(dir,'01-'+item.label+'.png'));
      manifest.push({game:item.game,url,ok:true,steps:item.steps});
    }catch(error){
      manifest.push({game:item.game,url,ok:false,error:error.message,steps:item.steps});
    }finally{
      await service.closeSession(session.id).catch(()=>{});
      await sleep(300);
    }
  }
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(manifest,null,2),'utf8');
  console.log(JSON.stringify(manifest,null,2));
}finally{
  await service.stop();
}
