import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const cases=[
  {id:'bigbucks-buy',game:'BigBucksSaloon',control:[105,550],followup:[]},
  {id:'blackbeard-buy',game:'BlackbeardsBounty',control:[1015,320],followup:[]},
  {id:'blackbeard-golden',game:'BlackbeardsBounty',control:[1015,405],followup:[[1150,680,2200]]},
  {id:'chicken-buy',game:'ChickenFire',control:[575,485],followup:[]},
  {id:'chicken-chance',game:'ChickenFire',control:[680,485],followup:[[640,660,2200]]},
];

const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function compact(events, marker){
  return events
    .filter(e=>e.seq>marker && ['request','response','responsebody','requestfailed'].includes(e.type))
    .map(e=>({
      seq:e.seq,
      type:e.type,
      requestId:e.requestId,
      url:e.url,
      method:e.method,
      status:e.status,
      postData:e.postData,
      body:e.body,
      errorText:e.errorText,
    }));
}

async function enterGame(internal){
  await sleep(7500);
  for(const [x,y,wait] of [
    [640,650,1200],
    [640,615,1000],
    [640,570,900],
    [640,680,900],
    [1140,650,1800],
  ]){
    await internal.page.mouse.click(x,y);
    await sleep(wait);
  }
  await sleep(2800);
}

await service.start();
try{
  const manifest=[];
  for(const probe of cases){
    const url=`https://demo.bgaming-network.com/play/${probe.game}/FUN`;
    const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
    const internal=service.sessions.get(s.id);
    const dir=path.join('artifacts','bg-jsonrpc-ui',probe.id);
    await fs.mkdir(dir,{recursive:true});
    try{
      await enterGame(internal);
      const before=await service.capture(s.id,'before');
      await fs.copyFile(path.resolve(before.path),path.join(dir,'before.png'));

      const marker=internal.recorder.marker();
      await internal.page.mouse.click(probe.control[0],probe.control[1]);
      await sleep(1100);
      const opened=await service.capture(s.id,'after-control');
      await fs.copyFile(path.resolve(opened.path),path.join(dir,'after-control.png'));

      for(const [x,y,wait] of probe.followup){
        await internal.page.mouse.click(x,y);
        await sleep(wait);
      }

      await internal.recorder.waitForQuiet({quietMs:600,timeoutMs:5000}).catch(()=>{});
      const final=await service.capture(s.id,'final');
      await fs.copyFile(path.resolve(final.path),path.join(dir,'final.png'));

      const events=compact(internal.recorder.eventsAfter(0),marker);
      await fs.writeFile(path.join(dir,'events.json'),JSON.stringify(events,null,2),'utf8');
      const requests=events
        .filter(e=>e.type==='request')
        .map(e=>({url:e.url,method:e.method,postData:e.postData}));
      manifest.push({...probe,url,ok:true,requests});
    }catch(error){
      manifest.push({...probe,url,ok:false,error:error.message});
    }finally{
      await service.closeSession(s.id);
      await sleep(400);
    }
  }

  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(manifest,null,2),'utf8');
  console.log(JSON.stringify(manifest,null,2));
}finally{
  await service.stop();
}
