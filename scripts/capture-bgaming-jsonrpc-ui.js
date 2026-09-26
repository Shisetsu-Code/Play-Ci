import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const targets=[
  {game:'SugarMix',url:'https://demo.bgaming-network.com/play/SugarMix/FUN',start:[640,650],action:{label:'buy-open',x:205,y:375}},
  {game:'YommiRush',url:'https://demo.bgaming-network.com/play/YommiRush/FUN',start:[1140,650],action:{label:'buy-open',x:260,y:390}},
  {game:'AztecsClawWildDice',url:'https://demo.bgaming-network.com/play/AztecsClawWildDice/FUN',start:[640,640],action:{label:'spin',x:1160,y:650}},
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

await service.start();
try{
  const manifest=[];
  for(const target of targets){
    const {game,url,start,action}=target;
    const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
    const internal=service.sessions.get(s.id);
    const dir=path.join('artifacts','bg-jsonrpc-ui',game);
    await fs.mkdir(dir,{recursive:true});
    try{
      await sleep(8000);
      const shot=await service.capture(s.id,'ready');
      await fs.copyFile(path.resolve(shot.path),path.join(dir,'ready.png'));

      await internal.page.mouse.click(start[0],start[1]);
      await sleep(2500);
      const gameShot=await service.capture(s.id,'game');
      await fs.copyFile(path.resolve(gameShot.path),path.join(dir,'game.png'));

      const marker=internal.recorder.marker();
      await internal.page.mouse.click(action.x,action.y);
      await sleep(1600);
      await internal.recorder.waitForQuiet({quietMs:500,timeoutMs:4000}).catch(()=>{});
      const actionShot=await service.capture(s.id,action.label);
      await fs.copyFile(path.resolve(actionShot.path),path.join(dir,action.label+'.png'));

      const events=compact(internal.recorder.eventsAfter(0),marker);
      await fs.writeFile(path.join(dir,'action-events.json'),JSON.stringify(events,null,2),'utf8');

      const state=await internal.page.evaluate(()=>({
        readyState:document.readyState,
        title:document.title,
        canvases:[...document.querySelectorAll('canvas')].map(c=>({w:c.width,h:c.height,rect:c.getBoundingClientRect().toJSON?.()||null})),
        text:document.body?.innerText?.slice(0,5000)||'',
      }));
      await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(state,null,2),'utf8');

      manifest.push({
        game,url,ok:true,action,state,
        action_requests:events.filter(e=>e.type==='request').map(e=>({url:e.url,method:e.method,postData:e.postData})),
      });
    }catch(error){
      manifest.push({game,url,ok:false,error:error.message,action});
    }finally{
      await service.closeSession(s.id);
    }
  }
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(manifest,null,2),'utf8');
  console.log(JSON.stringify(manifest.map(x=>({
    game:x.game,ok:x.ok,action:x.action,requests:x.action_requests||[],error:x.error||null,
  })),null,2));
}finally{
  await service.stop();
}
