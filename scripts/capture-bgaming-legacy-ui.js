import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const url='https://demo.bgaming-network.com/play/BookOfCats/FUN?server=demo';
const service=new BrowserService(config);
await service.start();
try{
  const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(s.id);
  await internal.page.waitForTimeout(5000);
  await fs.mkdir('artifacts/bg-legacy-ui',{recursive:true});
  const shot=await service.capture(s.id,'legacy-ready');
  await fs.copyFile(path.resolve(shot.path),'artifacts/bg-legacy-ui/ready.png');
  const state=await internal.page.evaluate(()=>({
    readyState:document.readyState,
    canvases:[...document.querySelectorAll('canvas')].map(c=>({width:c.width,height:c.height,rect:c.getBoundingClientRect().toJSON?.()||null})),
    buttons:[...document.querySelectorAll('button')].map(b=>({text:b.innerText,rect:b.getBoundingClientRect().toJSON?.()||null,visible:!!(b.offsetWidth||b.offsetHeight||b.getClientRects().length)})).filter(x=>x.visible),
  }));
  await fs.writeFile('artifacts/bg-legacy-ui/state.json',JSON.stringify(state,null,2),'utf8');
  await service.closeSession(s.id);
}finally{await service.stop()}
