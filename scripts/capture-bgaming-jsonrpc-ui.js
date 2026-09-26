import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const url='https://demo.bgaming-network.com/play/YommiRush/FUN';
const cases=[
  {
    id:'boost',
    action:[340,445],
    followup:[[1125,52,500],[1130,680,1800]],
  },
  {id:'buy-3-yommies',action:[660,445],followup:[]},
  {id:'buy-4-yommies',action:[943,445],followup:[]},
];
const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function compact(events, marker){
  return events
    .filter(e=>e.seq>marker && ['request','response','responsebody','requestfailed'].includes(e.type))
    .map(e=>({
      seq:e.seq,type:e.type,requestId:e.requestId,url:e.url,method:e.method,status:e.status,
      postData:e.postData,body:e.body,errorText:e.errorText,
    }));
}

async function enterGame(internal){
  await sleep(8000);
  await internal.page.mouse.click(1140,650);
  await sleep(2500);
}

async function openBuy(internal){
  await internal.page.mouse.click(260,390);
  await sleep(800);
}

await service.start();
try{
  const manifest=[];
  for(const probe of cases){
    const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
    const internal=service.sessions.get(s.id);
    const dir=path.join('artifacts','bg-jsonrpc-ui',probe.id);
    await fs.mkdir(dir,{recursive:true});
    try{
      await enterGame(internal);
      const gameShot=await service.capture(s.id,'game');
      await fs.copyFile(path.resolve(gameShot.path),path.join(dir,'game.png'));

      await openBuy(internal);
      const menuShot=await service.capture(s.id,'menu');
      await fs.copyFile(path.resolve(menuShot.path),path.join(dir,'menu.png'));

      const marker=internal.recorder.marker();
      await internal.page.mouse.click(probe.action[0],probe.action[1]);
      await sleep(1000);
      const selectedShot=await service.capture(s.id,'selected');
      await fs.copyFile(path.resolve(selectedShot.path),path.join(dir,'selected.png'));

      for(const [x,y,wait] of probe.followup){
        await internal.page.mouse.click(x,y);
        await sleep(wait);
      }
      await internal.recorder.waitForQuiet({quietMs:600,timeoutMs:5000}).catch(()=>{});
      const finalShot=await service.capture(s.id,'final');
      await fs.copyFile(path.resolve(finalShot.path),path.join(dir,'final.png'));

      const events=compact(internal.recorder.eventsAfter(0),marker);
      await fs.writeFile(path.join(dir,'events.json'),JSON.stringify(events,null,2),'utf8');
      const requests=events.filter(e=>e.type==='request').map(e=>({url:e.url,method:e.method,postData:e.postData}));
      manifest.push({id:probe.id,ok:true,action:probe.action,followup:probe.followup,requests});
    }catch(error){
      manifest.push({id:probe.id,ok:false,error:error.message});
    }finally{
      await service.closeSession(s.id);
    }
  }
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(manifest,null,2),'utf8');
  console.log(JSON.stringify(manifest,null,2));
}finally{
  await service.stop();
}
