import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const targets=[
 ['SugarMix','https://demo.bgaming-network.com/play/SugarMix/FUN'],
 ['YommiRush','https://demo.bgaming-network.com/play/YommiRush/FUN'],
 ['AztecsClawWildDice','https://demo.bgaming-network.com/play/AztecsClawWildDice/FUN'],
];
const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

await service.start();
try{
 const manifest=[];
 for(const [game,url] of targets){
  const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(s.id);
  const dir=path.join('artifacts','bg-jsonrpc-ui',game); await fs.mkdir(dir,{recursive:true});
  try{
   await sleep(8000);
   const shot=await service.capture(s.id,'ready');
   await fs.copyFile(path.resolve(shot.path),path.join(dir,'ready.png'));
   const state=await internal.page.evaluate(()=>({
     readyState:document.readyState,
     title:document.title,
     canvases:[...document.querySelectorAll('canvas')].map(c=>({w:c.width,h:c.height,rect:c.getBoundingClientRect().toJSON?.()||null})),
     text:document.body?.innerText?.slice(0,5000)||'',
   }));
   await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(state,null,2),'utf8');
   manifest.push({game,url,ok:true,state});
  }catch(error){manifest.push({game,url,ok:false,error:error.message});}
  finally{await service.closeSession(s.id)}
 }
 await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(manifest,null,2),'utf8');
}finally{await service.stop()}
