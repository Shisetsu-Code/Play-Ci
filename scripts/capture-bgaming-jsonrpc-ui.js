import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const cases=[
  {game:'BigBucksSaloon',steps:[]},
  {game:'BlazingFirepots',steps:[]},
  {game:'BlingBlitzDiamondDrop',steps:[[640,575,2200]]},
  {game:'ClashofGodsAnubisvsHades',steps:[[640,500,1500],[640,650,1200]]},
  {game:'GrandPatron7rst',steps:[[640,500,1500],[640,650,1200]]},
  {game:'HotRocket532',steps:[[735,360,1200],[640,620,1800]]},
  {game:'JewelBoom',steps:[[640,575,2200]]},
  {game:'JokerVsJoker',steps:[[640,500,1500],[640,650,1200]]},
  {game:'JungleQueen',steps:[[640,500,1500],[640,650,1200]]},
  {game:'KeepersOfTheSecret7rst',steps:[[640,500,1500],[640,650,1200]]},
  {game:'MysticReels',steps:[[640,500,1500],[640,650,1200]]},
  {game:'RedHotChilliChickens',steps:[[640,620,2200]]},
  {game:'SweetSamurai',steps:[[640,500,1500],[640,650,1200]]},
  {game:'ZeusGoesWild',steps:[[640,500,1500],[640,650,1200]]},
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
      await sleep(7600);
      const before=await service.capture(session.id,'before');
      await fs.copyFile(path.resolve(before.path),path.join(dir,'00-before.png'));
      for(const [x,y,wait] of item.steps){
        await internal.page.mouse.click(x,y).catch(()=>{});
        await sleep(wait);
      }
      await sleep(1400);
      const after=await service.capture(session.id,'game');
      await fs.copyFile(path.resolve(after.path),path.join(dir,'01-game.png'));
      manifest.push({game:item.game,url,ok:true,steps:item.steps,final_url:internal.page.url()});
    }catch(error){
      manifest.push({game:item.game,url,ok:false,error:error.message,steps:item.steps});
    }finally{
      await service.closeSession(session.id).catch(()=>{});
      await sleep(250);
    }
  }
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(manifest,null,2),'utf8');
  console.log(JSON.stringify(manifest,null,2));
}finally{
  await service.stop();
}
