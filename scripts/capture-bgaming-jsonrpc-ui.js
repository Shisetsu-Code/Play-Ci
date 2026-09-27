import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const games=[
  'RecycleRiches',
  'RocketEruptionTripleBlast',
  'TheGodfather3PillarsOfPower',
  'SweetSamurai',
  'GrandPatron7rst',
];
const service=new BrowserService({...config,maxBodyBytes:24*1024*1024,maxMemoryEvents:60000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function safe(url){
  const tail=url.split('/').pop()?.split('?')[0]||'asset';
  return tail.replace(/[^A-Za-z0-9._-]+/g,'_').slice(0,140);
}

function relevant(url,body){
  if(typeof body!=='string'||body.length<20)return false;
  if(/\.(?:js|mjs)(?:\?|$)/i.test(url||''))return true;
  if(/\.json(?:\?|$)/i.test(url||'')&&/buy|bonus|feature|bet|wager|round|mode|definition|config|slot|shop|ante/i.test(body))return true;
  return false;
}

async function capture(game){
  const url=`https://demo.bgaming-network.com/play/${game}/FUN?server=demo`;
  const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  const dir=path.join('artifacts','bg-jsonrpc-ui','raw',game);
  await fs.mkdir(dir,{recursive:true});
  try{
    await sleep(10500);
    await internal.recorder.waitForQuiet({quietMs:650,timeoutMs:4000}).catch(()=>{});
    const events=internal.recorder.eventsAfter(0);
    const saved=[];
    for(const e of events){
      if(e.type!=='responsebody'||!relevant(e.url,e.body))continue;
      const ext=/\.json(?:\?|$)/i.test(e.url||'')?'json':'txt';
      const name=`${String(saved.length).padStart(3,'0')}-${safe(e.url)}-${crypto.createHash('sha1').update(e.url||'').digest('hex').slice(0,8)}.${ext}`;
      await fs.writeFile(path.join(dir,name),e.body,'utf8');
      saved.push({url:e.url,file:name,bytes:Buffer.byteLength(e.body)});
      if(saved.length>=80)break;
    }
    await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(saved,null,2),'utf8');
    return {game,ok:true,final_url:internal.page.url(),saved};
  }catch(error){
    return {game,ok:false,error:error.message,saved:[]};
  }finally{
    await service.closeSession(session.id).catch(()=>{});
  }
}

await service.start();
try{
  const results=[];
  for(const game of games){
    results.push(await capture(game));
    await sleep(350);
  }
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results.map(r=>({
    game:r.game,ok:r.ok,files:r.saved.length,error:r.error||null,
  })),null,2));
}finally{await service.stop()}
