import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const cases=[
  {id:'goreel-1-0',family:'goreel',game:'buddha_megaways',open:[72,228]},
  {id:'goreel-3-0',family:'goreel',game:'coin_lamp',open:[140,289]},
  {id:'goreel-3-1',family:'goreel',game:'lady_fortune',open:[105,260]},
  {id:'goreel-3-3',family:'goreel',game:'dj_tiger_x1000',open:[1195,233]},
  {id:'goreel-4-0',family:'goreel',game:'super_china_pots',open:[145,242]},
  {id:'goreel-4-4',family:'goreel',game:'egypt_power_x1000',open:[1195,233]},
  {id:'hraymo-4-0',family:'hraymo',game:'4_african_drums',open:[145,310]},
  {id:'ratpack-1-0',family:'ratpack',game:'3_clover_pots_extra',open:[155,221]},
  {id:'ratpack-2-0',family:'ratpack',game:'4_clover_pots',open:[1195,233]},
  {id:'ratpack-3-1',family:'ratpack',game:'lava_coins_2',open:[165,590]},
  {id:'ratpack-4-0',family:'ratpack',game:'777_fruity_coins',open:[135,148]},
];

const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function enter(page,family){
  if(family==='goreel'){
    await sleep(3500); await page.mouse.click(640,670); await sleep(1800);
  } else if(family==='hraymo'){
    await sleep(4000); await page.mouse.click(640,360); await sleep(2500);
  } else if(family==='ratpack'){
    await sleep(6500); await page.mouse.click(640,360); await sleep(3000);
  }
}

await service.start();
try{
  const manifest=[];
  for(const c of cases){
    const url=`https://3oaks.com/api/v1/games/${c.game}/play?lang=en`;
    const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
    const internal=service.sessions.get(s.id);
    const dir=path.join('artifacts','layout-popups',c.id);
    await fs.mkdir(dir,{recursive:true});
    try{
      await enter(internal.page,c.family);
      await internal.page.mouse.click(c.open[0],c.open[1]);
      await sleep(1200);
      const shot=await service.capture(s.id,'popup');
      await fs.copyFile(path.resolve(shot.path),path.join(dir,'popup.png'));
      manifest.push({...c,url,ok:true,path:path.join(dir,'popup.png')});
    }catch(error){
      manifest.push({...c,url,ok:false,error:error.message});
    }finally{await service.closeSession(s.id);}
  }
  await fs.writeFile('artifacts/layout-popups/manifest.json',JSON.stringify(manifest,null,2),'utf8');
}finally{await service.stop();}
