import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const service = new BrowserService(config);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cases = [
  {
    family:'hraymo', game:'3_african_drums',
    url:'https://3oaks.com/api/v1/games/3_african_drums/play?lang=en',
    steps:[
      {wait:4000,label:'01-preclick'},
      {click:[640,360],wait:2500,label:'02-after-center'},
    ],
  },
  {
    family:'ratpack', game:'4_super_clover_pots',
    url:'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en',
    steps:[
      {wait:6500,label:'01-waited'},
      {click:[640,360],wait:3000,label:'02-after-center'},
    ],
  },
  {
    family:'kendoo', game:'3_coin_volcanoes',
    url:'https://3oaks.com/api/v1/games/3_coin_volcanoes/play?lang=en',
    steps:[
      {wait:6500,label:'01-waited'},
      {click:[640,360],wait:3000,label:'02-after-center'},
    ],
  },
  {
    family:'goreel', game:'3_aztec_temples',
    url:'https://3oaks.com/api/v1/games/3_aztec_temples/play?lang=en',
    steps:[
      {wait:3500,label:'01-ready'},
      {click:[640,670],wait:1800,label:'02-entered'},
      {click:[150,195],wait:1200,label:'03-bonus-popup'},
    ],
  },
  {
    family:'enjoy', game:'3_superpower_diamonds',
    url:'https://3oaks.com/api/v1/games/3_superpower_diamonds/play?lang=en',
    steps:[
      {wait:3500,label:'01-ready'},
      {click:[640,670],wait:1800,label:'02-entered'},
      {click:[1195,233],wait:1200,label:'03-bonus-popup'},
    ],
  },
];

await service.start();
try {
  const manifest=[];
  for(const c of cases){
    const s=await service.createSession({url:c.url,skipSplash:false,captureInitialScreenshot:false});
    const internal=service.sessions.get(s.id);
    const outDir=path.join('artifacts','visual-pass2',c.family);
    await fs.mkdir(outDir,{recursive:true});
    const shots=[];
    for(const step of c.steps){
      if(step.wait) await sleep(step.wait);
      if(step.click){
        await internal.page.mouse.click(step.click[0],step.click[1]);
        if(step.wait) await sleep(step.wait);
      }
      const shot=await service.capture(s.id,step.label);
      const dest=path.join(outDir,`${step.label}.png`);
      await fs.copyFile(path.resolve(shot.path),dest);
      shots.push({label:step.label,click:step.click||null,path:dest});
    }
    manifest.push({...c,shots});
    await service.closeSession(s.id);
  }
  await fs.writeFile(
    path.join('artifacts','visual-pass2','manifest.json'),
    JSON.stringify(manifest,null,2),
    'utf8'
  );
}finally{
  await service.stop();
}
