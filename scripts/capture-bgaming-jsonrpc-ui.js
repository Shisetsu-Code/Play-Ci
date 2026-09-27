import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const cases=[
  {id:'blackbeard-buy-100x',game:'BlackbeardsBounty',open:[1015,320],select:[755,309]},
  {id:'blackbeard-buy-200x',game:'BlackbeardsBounty',open:[1015,320],select:[755,369]},
  {id:'chicken-buy-60x',game:'ChickenFire',open:[575,485],select:[780,190]},
  {id:'chicken-buy-90x',game:'ChickenFire',open:[575,485],select:[780,315]},
  {id:'chicken-buy-120x',game:'ChickenFire',open:[575,485],select:[780,440]},
  {id:'chicken-chance',game:'ChickenFire',open:[680,485],select:[575,420],spin:[640,660]},
  {id:'bigbucks-buy-a',game:'BigBucksSaloon',open:[110,535]},
  {id:'bigbucks-buy-b',game:'BigBucksSaloon',open:[110,585]},
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
  await sleep(7200);
  for(const [x,y,wait] of [
    [640,650,1100],
    [640,615,900],
    [640,570,800],
    [640,680,800],
    [1140,650,1600],
  ]){
    await internal.page.mouse.click(x,y);
    await sleep(wait);
  }
  await sleep(3000);
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

      await internal.page.mouse.click(probe.open[0],probe.open[1]);
      await sleep(900);
      const opened=await service.capture(s.id,'opened');
      await fs.copyFile(path.resolve(opened.path),path.join(dir,'opened.png'));

      const marker=internal.recorder.marker();
      if(probe.select){
        await internal.page.mouse.click(probe.select[0],probe.select[1]);
        await sleep(1400);
      }
      if(probe.spin){
        await internal.page.mouse.click(probe.spin[0],probe.spin[1]);
        await sleep(2200);
      }

      await internal.recorder.waitForQuiet({quietMs:600,timeoutMs:5000}).catch(()=>{});
      const final=await service.capture(s.id,'final');
      await fs.copyFile(path.resolve(final.path),path.join(dir,'final.png'));

      const events=compact(internal.recorder.eventsAfter(0),marker);
      await fs.writeFile(path.join(dir,'events.json'),JSON.stringify(events,null,2),'utf8');
      const requests=events.filter(e=>e.type==='request').map(e=>({url:e.url,method:e.method,postData:e.postData}));
      const responses=events.filter(e=>e.type==='responsebody').map(e=>({url:e.url,body:e.body}));
      manifest.push({...probe,url,ok:true,requests,responses});
    }catch(error){
      manifest.push({...probe,url,ok:false,error:error.message});
    }finally{
      await service.closeSession(s.id);
      await sleep(350);
    }
  }
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(manifest,null,2),'utf8');
  console.log(JSON.stringify(manifest.map(x=>({
    id:x.id,
    game:x.game,
    ok:x.ok,
    requests:x.requests||[],
    responseBodies:(x.responses||[]).map(r=>r.body?.slice?.(0,1400) ?? r.body),
    error:x.error||null,
  })),null,2));
}finally{
  await service.stop();
}
