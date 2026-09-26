import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const url='https://3oaks.com/api/v1/games/3_coin_volcanoes/play?lang=en';

await service.start();
try{
  const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(s.id);
  await sleep(30000);
  const shot=await service.capture(s.id,'headed-30s');
  await fs.mkdir('artifacts/kendoo-headed',{recursive:true});
  await fs.copyFile(shot.path,'artifacts/kendoo-headed/30s.png');
  const state=await internal.page.evaluate(()=>({
    readyState:document.readyState,
    buyVisible:(()=>{try{return window.GR?.UI?.view?.buy_feature?.visible?.()??null}catch{return null}})(),
    buyDisabled:(()=>{try{return window.GR?.UI?.view?.buy_feature?.disabled?.()??null}catch{return null}})(),
    board:Boolean(window.app?.board),
    preloader:(()=>{try{return window.GR?.UI?.model?.get?.('preloader_hidden')??null}catch{return null}})(),
    controls:(()=>{try{return window.GR?.UI?.model?.get?.('controls.available')??null}catch{return null}})(),
  }));
  await fs.writeFile('artifacts/kendoo-headed/state.json',JSON.stringify(state,null,2),'utf8');
  console.log(JSON.stringify(state,null,2));
  await service.closeSession(s.id);
}finally{await service.stop();}
