import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const games=[
  'BigBucksSaloon','BlazingFirepots','BlingBlitzDiamondDrop','ClashofGodsAnubisvsHades',
  'GrandPatron7rst','HotRocket532','JewelBoom','MysticReels','SugarMix',
  'SweetSamurai','YommiRush','ZeusGoesWild',
];
const interesting=/BUY_BONUS_COSTS|buyFeatures|buyFeature|buyBonus|featureMultiplier|featureBet|buy_chance|buy_bonus|bonus_buy|purchased_feature|custom_field|bonus_multiplier_type|feature_id|buy_id|machineId/i;

const service=new BrowserService({...config,maxBodyBytes:16*1024*1024,maxMemoryEvents:40000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function safeName(url){
  const tail=url.split('/').pop()?.split('?')[0]||'bundle.js';
  return tail.replace(/[^A-Za-z0-9._-]+/g,'_').slice(0,120);
}

async function inspect(game){
  const url=`https://demo.bgaming-network.com/play/${game}/FUN`;
  const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  const dir=path.join('artifacts','bg-jsonrpc-ui','sources',game);
  await fs.mkdir(dir,{recursive:true});
  try{
    await sleep(7200);
    await internal.recorder.waitForQuiet({quietMs:450,timeoutMs:2500}).catch(()=>{});
    const events=internal.recorder.eventsAfter(0);
    const saved=[];
    for(const e of events){
      if(e.type!=='responsebody'||typeof e.body!=='string'||e.body.length<500)continue;
      if(!/\.(?:js|mjs)(?:\?|$)/i.test(e.url||''))continue;
      if(!interesting.test(e.body))continue;
      const name=`${String(saved.length).padStart(2,'0')}-${safeName(e.url)}-${crypto.createHash('sha1').update(e.url).digest('hex').slice(0,8)}.txt`;
      await fs.writeFile(path.join(dir,name),e.body,'utf8');
      saved.push({url:e.url,file:name,bytes:Buffer.byteLength(e.body)});
      if(saved.length>=8)break;
    }
    await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(saved,null,2),'utf8');
    return {game,ok:true,saved};
  }catch(error){
    return {game,ok:false,error:error.message,saved:[]};
  }finally{
    await service.closeSession(session.id).catch(()=>{});
  }
}

async function pool(items,limit,fn){
  const out=new Array(items.length);let cursor=0;
  async function worker(){while(true){const i=cursor++;if(i>=items.length)return;out[i]=await fn(items[i]);await sleep(250)}}
  await Promise.all(Array.from({length:limit},worker));
  return out;
}

await service.start();
try{
  const results=await pool(games,3,inspect);
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results.map(r=>({
    game:r.game,ok:r.ok,
    saved:r.saved.map(s=>({url:s.url,file:s.file,bytes:s.bytes})),
    error:r.error||null,
  })),null,2));
}finally{await service.stop()}
