import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const cases=[
  ['goreel-1-0','goreel','buddha_megaways'],
  ['goreel-3-0','goreel','coin_lamp'],
  ['goreel-3-1','goreel','lady_fortune'],
  ['goreel-3-3','goreel','dj_tiger_x1000'],
  ['goreel-4-0','goreel','super_china_pots'],
  ['goreel-4-4','goreel','egypt_power_x1000'],
  ['hraymo-4-0','hraymo','4_african_drums'],
  ['ratpack-1-0','ratpack','3_clover_pots_extra'],
  ['ratpack-2-0','ratpack','4_clover_pots'],
  ['ratpack-3-1','ratpack','lava_coins_2'],
  ['ratpack-3-4','ratpack','joker_glitz_x1000'],
  ['ratpack-4-0','ratpack','777_fruity_coins'],
];

const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function prepare(page,family){
  if(family==='goreel'){
    await sleep(3500);
    await page.mouse.click(640,670);
    await sleep(1800);
    await page.mouse.click(150,195);
    await sleep(1200);
  }else if(family==='hraymo'){
    await sleep(4000);
    await page.mouse.click(640,360);
    await sleep(2500);
    await page.mouse.click(135,258);
    await sleep(1200);
  }else if(family==='ratpack'){
    await sleep(6500);
    await page.mouse.click(640,360);
    await sleep(3000);
    await page.mouse.click(1195,233);
    await sleep(1200);
  }
}

await service.start();
try{
  const manifest=[];
  for(const [id,family,game] of cases){
    const url=`https://3oaks.com/api/v1/games/${game}/play?lang=en`;
    const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
    const internal=service.sessions.get(s.id);
    const dir=path.join('artifacts','layout-profiles',id);
    await fs.mkdir(dir,{recursive:true});
    try{
      await prepare(internal.page,family);
      const shot=await service.capture(s.id,'popup');
      await fs.copyFile(path.resolve(shot.path),path.join(dir,'popup.png'));
      manifest.push({id,family,game,url,ok:true,path:path.join(dir,'popup.png')});
    }catch(error){
      manifest.push({id,family,game,url,ok:false,error:error.message});
    }finally{
      await service.closeSession(s.id);
    }
  }
  await fs.writeFile('artifacts/layout-profiles/manifest.json',JSON.stringify(manifest,null,2),'utf8');
}finally{await service.stop();}
