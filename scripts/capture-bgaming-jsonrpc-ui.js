import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const games=[
  'AztecsClawWildDice','BigBucksSaloon','BlackbeardsBounty','BlazingFirepots',
  'BlingBlitzDiamondDrop','CatsLoveYummy','ChickenFire','ClashofGodsAnubisvsHades',
  'CluckingHell','GrandPatron7rst','HotRocket532','JewelBoom','JokerVsJoker',
  'JungleQueen','KeepersOfTheSecret7rst','MultiRush','MysticReels','RecycleRiches',
  'RedHotChilliChickens','RocketEruptionTripleBlast','StarTrekNextGen','SugarMix',
  'SweetSamurai','GatesOfPower','TheGodfather3PillarsOfPower','TreasureExplorer',
  'WildClustersP','YommiRush','ZeusGoesWild',
];

const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function inspect(game){
  const url=`https://demo.bgaming-network.com/play/${game}/FUN`;
  const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  const dir=path.join('artifacts','bg-jsonrpc-ui',game);
  await fs.mkdir(dir,{recursive:true});
  try{
    await sleep(6500);

    const ready=await service.capture(session.id,'ready');
    await fs.copyFile(path.resolve(ready.path),path.join(dir,'00-ready.png'));

    const sequence=[
      [640,650,800],
      [640,615,700],
      [640,570,700],
      [640,500,700],
      [640,360,700],
      [1140,650,1200],
    ];
    for(const [x,y,wait] of sequence){
      await internal.page.mouse.click(x,y);
      await sleep(wait);
    }

    await sleep(1600);
    const gameShot=await service.capture(session.id,'game');
    await fs.copyFile(path.resolve(gameShot.path),path.join(dir,'01-game.png'));

    const state=await internal.page.evaluate(()=>({
      final_url:location.href,
      readyState:document.readyState,
      title:document.title,
      bodyText:(document.body?.innerText||'').replace(/\s+/g,' ').trim().slice(0,2500),
      frameCount:document.querySelectorAll('iframe').length,
      canvasCount:document.querySelectorAll('canvas').length,
    })).catch(error=>({error:error.message}));

    await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(state,null,2),'utf8');
    return {game,url,ok:true,state};
  }catch(error){
    return {game,url,ok:false,error:error.message};
  }finally{
    await service.closeSession(session.id);
  }
}

async function pool(items,limit,fn){
  const out=new Array(items.length);
  let cursor=0;
  async function worker(){
    while(true){
      const i=cursor++;
      if(i>=items.length)return;
      out[i]=await fn(items[i]);
      await sleep(300);
    }
  }
  await Promise.all(Array.from({length:limit},worker));
  return out;
}

await service.start();
try{
  const results=await pool(games,4,inspect);
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results.map(r=>({
    game:r.game,
    ok:r.ok,
    final_url:r.state?.final_url||null,
    bodyText:r.state?.bodyText||'',
    canvasCount:r.state?.canvasCount??null,
    error:r.error||null,
  })),null,2));
}finally{
  await service.stop();
}
