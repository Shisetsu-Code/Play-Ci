import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const url='https://demo.bgaming-network.com/play/BookOfCats/FUN?server=demo';
const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function compact(events, marker){
  return events.filter(e=>e.seq>marker && ['request','response','responsebody'].includes(e.type)).map(e=>({
    seq:e.seq,type:e.type,requestId:e.requestId,url:e.url,method:e.method,status:e.status,
    postData:e.postData,body:e.body
  }));
}

async function enter(internal){
  await sleep(4000);
  await internal.page.mouse.click(640,570);
  await sleep(2200);
}

async function runCase(name, clicks){
  const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(s.id);
  const dir=path.join('artifacts','bg-legacy-clicks',name);
  await fs.mkdir(dir,{recursive:true});
  try{
    await enter(internal);
    const before=await service.capture(s.id,'before');
    await fs.copyFile(path.resolve(before.path),path.join(dir,'before.png'));
    const marker=internal.recorder.marker();
    const performed=[];
    for(const [label,x,y,wait] of clicks){
      await internal.page.mouse.click(x,y);
      performed.push({label,x,y});
      await sleep(wait);
      const shot=await service.capture(s.id,label);
      await fs.copyFile(path.resolve(shot.path),path.join(dir,label+'.png'));
    }
    await internal.recorder.waitForQuiet({quietMs:700,timeoutMs:6000}).catch(()=>{});
    const events=compact(internal.recorder.eventsAfter(0),marker);
    await fs.writeFile(path.join(dir,'events.json'),JSON.stringify(events,null,2),'utf8');
    return {name,performed,events};
  }finally{await service.closeSession(s.id)}
}

await service.start();
try{
  const spin=await runCase('spin',[[ 'spin-click',1128,680,1800 ]]);
  const buy=await runCase('buy',[[ 'buy-open',338,45,900 ],[ 'buy-confirm',750,448,1800 ]]);
  const report={spin,buy};
  await fs.writeFile('artifacts/bg-legacy-clicks/report.json',JSON.stringify(report,null,2),'utf8');
  console.log(JSON.stringify({
    spin:spin.events.filter(e=>e.type==='request').map(e=>({url:e.url,method:e.method,postData:e.postData})),
    buy:buy.events.filter(e=>e.type==='request').map(e=>({url:e.url,method:e.method,postData:e.postData}))
  },null,2));
}finally{await service.stop()}
