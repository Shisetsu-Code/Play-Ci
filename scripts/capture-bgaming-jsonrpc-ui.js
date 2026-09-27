import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const url='https://demo.bgaming-network.com/play/AllLuckyClover/FUN?server=demo';
const modes=[
  {lines:5,x:310,y:370},
  {lines:20,x:530,y:370},
  {lines:40,x:750,y:370},
  {lines:100,x:970,y:370},
];
const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function apiRequests(events,marker){
  return events.filter(e=>e.seq>marker&&e.type==='request'&&/bgaming-network\.com\/api\//i.test(e.url||'')).map(e=>({
    url:e.url,method:e.method,postData:e.postData,
  }));
}

await service.start();
try{
  const manifest=[];
  for(const mode of modes){
    const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
    const internal=service.sessions.get(session.id);
    const dir=path.join('artifacts','bg-jsonrpc-ui','AllLuckyClover',String(mode.lines));
    await fs.mkdir(dir,{recursive:true});
    try{
      await sleep(6500);
      await internal.page.mouse.click(mode.x,mode.y);
      await sleep(2200);
      let shot=await service.capture(session.id,'game');
      await fs.copyFile(path.resolve(shot.path),path.join(dir,'00-game.png'));

      // Capture the wager selector state without spinning.
      await internal.page.mouse.click(410,665).catch(()=>{});
      await sleep(900);
      shot=await service.capture(session.id,'bet-selector');
      await fs.copyFile(path.resolve(shot.path),path.join(dir,'01-bet-selector.png'));

      const marker=internal.recorder.marker();
      await internal.page.mouse.click(1125,680).catch(()=>{});
      await sleep(1800);
      await internal.recorder.waitForQuiet({quietMs:500,timeoutMs:3500}).catch(()=>{});
      const requests=apiRequests(internal.recorder.eventsAfter(0),marker);
      manifest.push({lines:mode.lines,ok:true,requests});
    }catch(error){
      manifest.push({lines:mode.lines,ok:false,error:error.message});
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
