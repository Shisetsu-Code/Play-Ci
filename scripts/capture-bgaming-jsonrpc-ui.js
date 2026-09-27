import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const games=[
  'BigBucksSaloon','BlazingFirepots','BlingBlitzDiamondDrop','ClashofGodsAnubisvsHades',
  'GrandPatron7rst','HotRocket532','JewelBoom','JokerVsJoker','JungleQueen',
  'KeepersOfTheSecret7rst','MysticReels','RedHotChilliChickens','SugarMix',
  'SweetSamurai','YommiRush','ZeusGoesWild',
];
const terms=[
  'BUY_BONUS_COSTS','buyFeatures','buyFeature','buyBonus','buy_bonus_feature',
  'bonus_multiplier_type','featureMultiplier','featureBet','chance_x',
  'freespinsX','buy_freespins','buy_free_spins','super_buy_bonus',
  'buy_chance','buy_bonus_and_chance','custom_field','bonus_buy',
  'feature_id','buy_id','machineId','purchased_feature',
];

const service=new BrowserService({...config,maxBodyBytes:12*1024*1024,maxMemoryEvents:35000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function snippets(body,term,max=4){
  const out=[];
  const lower=body.toLowerCase();
  const needle=term.toLowerCase();
  let from=0;
  while(out.length<max){
    const at=lower.indexOf(needle,from);
    if(at<0)break;
    out.push(body.slice(Math.max(0,at-1100),Math.min(body.length,at+term.length+1800)).replace(/\s+/g,' '));
    from=at+needle.length;
  }
  return out;
}

async function inspect(game){
  const url=`https://demo.bgaming-network.com/play/${game}/FUN`;
  const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  try{
    await sleep(7200);
    await internal.recorder.waitForQuiet({quietMs:450,timeoutMs:2400}).catch(()=>{});
    const events=internal.recorder.eventsAfter(0);
    const sources=[];
    for(const e of events){
      if(e.type!=='responsebody'||typeof e.body!=='string'||e.body.length<1000)continue;
      if(!/\.(?:js|mjs)(?:\?|$)/i.test(e.url||''))continue;
      const hits=[];
      for(const term of terms){
        for(const snippet of snippets(e.body,term))hits.push({term,snippet});
      }
      if(hits.length)sources.push({url:e.url,bytes:Buffer.byteLength(e.body),hits:hits.slice(0,90)});
      if(sources.length>=12)break;
    }
    return {game,url,ok:true,sources};
  }catch(error){
    return {game,url,ok:false,error:error.message,sources:[]};
  }finally{
    await service.closeSession(session.id).catch(()=>{});
  }
}

async function pool(items,limit,fn){
  const out=new Array(items.length);let cursor=0;
  async function worker(){while(true){const i=cursor++;if(i>=items.length)return;out[i]=await fn(items[i]);await sleep(200)}}
  await Promise.all(Array.from({length:limit},worker));
  return out;
}

await service.start();
try{
  const results=await pool(games,4,inspect);
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/unresolved-feature-source.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results.map(r=>({
    game:r.game,ok:r.ok,
    sources:r.sources.map(s=>({url:s.url,terms:[...new Set(s.hits.map(h=>h.term))]})),
    error:r.error||null,
  })),null,2));
}finally{
  await service.stop();
}
