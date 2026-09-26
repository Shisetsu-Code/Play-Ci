import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const url='https://demo.bgaming-network.com/play/SugarMix/FUN';
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

await service.start();
try{
  const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(s.id);
  const dir=path.join('artifacts','bg-jsonrpc-ui','SugarMix');
  await fs.mkdir(dir,{recursive:true});
  const result={game:'SugarMix',ok:false};
  try{
    await sleep(8000);
    for(const [label,x,y,wait] of [
      ['startup-1',640,650,2500],
      ['startup-2',640,615,2200],
    ]){
      await internal.page.mouse.click(x,y);
      await sleep(wait);
      const shot=await service.capture(s.id,label);
      await fs.copyFile(path.resolve(shot.path),path.join(dir,label+'.png'));
    }

    const gameShot=await service.capture(s.id,'game');
    await fs.copyFile(path.resolve(gameShot.path),path.join(dir,'game.png'));

    const marker=internal.recorder.marker();
    await internal.page.mouse.click(200,390);
    await sleep(1000);
    const menuShot=await service.capture(s.id,'menu');
    await fs.copyFile(path.resolve(menuShot.path),path.join(dir,'menu.png'));

    const events=compact(internal.recorder.eventsAfter(0),marker);
    await fs.writeFile(path.join(dir,'open-events.json'),JSON.stringify(events,null,2),'utf8');
    result.ok=true;
    result.requests=events.filter(e=>e.type==='request').map(e=>({url:e.url,method:e.method,postData:e.postData}));
  }catch(error){
    result.error=error.message;
  }finally{
    await service.closeSession(s.id);
  }
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(result,null,2),'utf8');
  console.log(JSON.stringify(result,null,2));
}finally{
  await service.stop();
}
