import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const games=[
  'BigBucksSaloon',
  'BlingBlitzDiamondDrop',
  'GrandPatron7rst',
  'HotRocket532',
  'JewelBoom',
  'ZeusGoesWild',
];
const service=new BrowserService({...config,maxBodyBytes:20*1024*1024,maxMemoryEvents:50000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function safeName(url){
  const tail=url.split('/').pop()?.split('?')[0]||'asset';
  return tail.replace(/[^A-Za-z0-9._-]+/g,'_').slice(0,120);
}

function useful(url,body){
  if(typeof body!=='string'||body.length<40)return false;
  if(/\.(?:js|mjs|json)(?:\?|$)/i.test(url||''))return true;
  if(/\/api(?:\/|\?|$)|game.?config|definition|slot.?parameters/i.test(url||''))return true;
  return /purchased_features|featureBuyMul|buyBonusMultiplier|buy_bonus|buy_chance/i.test(body);
}

async function inspect(game){
  const url=`https://demo.bgaming-network.com/play/${game}/FUN?server=demo`;
  const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  const dir=path.join('artifacts','bg-jsonrpc-ui','sources',game);
  await fs.mkdir(dir,{recursive:true});
  try{
    await sleep(10000);
    await internal.recorder.waitForQuiet({quietMs:600,timeoutMs:3500}).catch(()=>{});
    const events=internal.recorder.eventsAfter(0);
    const saved=[];
    for(const e of events){
      if(e.type!=='responsebody'||!useful(e.url,e.body))continue;
      const ext=/\.json(?:\?|$)/i.test(e.url||'')?'json':'txt';
      const name=`${String(saved.length).padStart(2,'0')}-${safeName(e.url)}-${crypto.createHash('sha1').update(e.url||'').digest('hex').slice(0,8)}.${ext}`;
      await fs.writeFile(path.join(dir,name),e.body,'utf8');
      saved.push({url:e.url,file:name,bytes:Buffer.byteLength(e.body)});
      if(saved.length>=40)break;
    }
    return {
      game,ok:true,final_url:internal.page.url(),
      title:await internal.page.title().catch(()=>null),
      saved,
    };
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
    results.push(await inspect(game));
    await sleep(350);
  }
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results.map(r=>({
    game:r.game,ok:r.ok,final_url:r.final_url||null,title:r.title||null,
    saved:r.saved.map(s=>({url:s.url,file:s.file,bytes:s.bytes})),
    error:r.error||null,
  })),null,2));
}finally{
  await service.stop();
}
