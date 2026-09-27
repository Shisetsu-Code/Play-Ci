import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractBgamingJsonRpcInit } from '../src/providers/bgaming.js';

const games=[
  'AztecsClawWildDice','BigBucksSaloon','BlackbeardsBounty','BlazingFirepots',
  'BlingBlitzDiamondDrop','CatsLoveYummy','ChickenFire','ClashofGodsAnubisvsHades',
  'CluckingHell','GrandPatron7rst','HotRocket532','JewelBoom','JokerVsJoker',
  'JungleQueen','KeepersOfTheSecret7rst','MultiRush','MysticReels','RecycleRiches',
  'RedHotChilliChickens','RocketEruptionTripleBlast','StarTrekNextGen','SugarMix',
  'SweetSamurai','GatesOfPower','TheGodfather3PillarsOfPower','TreasureExplorer',
  'WildClustersP','YommiRush','ZeusGoesWild',
];

const service=new BrowserService({
  ...config,
  maxBodyBytes:8*1024*1024,
  maxMemoryEvents:30000,
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const interesting=/(?:buy|purchas|feature|chance|bonus|price|cost|multiplier|rtp|respin|free.?spin)/i;

function parseJson(text){
  try{return JSON.parse(text)}catch{return null}
}

function compactValue(value){
  if(value==null || typeof value==='string' || typeof value==='number' || typeof value==='boolean') return value;
  try{
    const text=JSON.stringify(value);
    if(text.length<=3500) return value;
    return text.slice(0,3500)+'…';
  }catch{
    return String(value).slice(0,3500);
  }
}

function walk(value,path='',depth=0,out=[]){
  if(depth>12 || out.length>=350) return out;
  if(Array.isArray(value)){
    value.slice(0,120).forEach((v,i)=>walk(v,`${path}[${i}]`,depth+1,out));
    return out;
  }
  if(!value || typeof value!=='object') return out;

  for(const [key,val] of Object.entries(value)){
    const next=path ? `${path}.${key}` : key;
    if(interesting.test(key) || interesting.test(next)){
      out.push({path:next,value:compactValue(val)});
      if(out.length>=350) return out;
    }
    if(val && typeof val==='object') walk(val,next,depth+1,out);
    if(out.length>=350) return out;
  }
  return out;
}

function sourcePriority(url){
  const lower=url.toLowerCase();
  if(/\/api\/?(?:$|\?)/.test(lower)) return 5;
  if(/gameconfig|game-config|config\.|\/config\/|definitions|clientconfig/.test(lower)) return 4;
  if(/localization|locale|lang/.test(lower)) return 2;
  if(/\.json(?:\?|$)/.test(lower)) return 1;
  return 0;
}

async function inspect(game){
  const url=`https://demo.bgaming-network.com/play/${game}/FUN`;
  const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  try{
    await sleep(6500);
    await internal.recorder.waitForQuiet({quietMs:450,timeoutMs:2500}).catch(()=>{});
    const events=internal.recorder.eventsAfter(0);
    const init=extractBgamingJsonRpcInit(events);
    const docs=[];

    for(const event of events){
      if(event.type!=='responsebody' || typeof event.body!=='string' || !event.body) continue;
      const body=parseJson(event.body);
      if(!body) continue;
      const hits=walk(body);
      if(hits.length===0) continue;
      docs.push({
        url:event.url,
        priority:sourcePriority(event.url),
        bytes:Buffer.byteLength(event.body),
        top_keys:Array.isArray(body)?['<array>']:Object.keys(body).slice(0,60),
        hits,
      });
    }
    docs.sort((a,b)=>b.priority-a.priority || a.url.localeCompare(b.url));

    return {
      game,url,ok:true,
      final_url:internal.page.url(),
      init:{
        endpoint:init?.request?.url||null,
        purchased_features:init?.body?.result?.config?.purchased_features||[],
        default_bet:init?.body?.result?.config?.default_bet??null,
        bet_limits:init?.body?.result?.config?.bet_limits||[],
        state_lock:init?.body?.result?.state_lock??null,
      },
      docs:docs.slice(0,45),
    };
  }catch(error){
    return {game,url,ok:false,error:error.message};
  }finally{
    await service.closeSession(session.id);
  }
}

async function pool(items,limit,fn){
  const out=new Array(items.length);
  let cursor=0;
  async function worker(){
    while(true){
      const i=cursor++;
      if(i>=items.length) return;
      out[i]=await fn(items[i]);
      await sleep(250);
    }
  }
  await Promise.all(Array.from({length:limit},worker));
  return out;
}

await service.start();
try{
  const results=await pool(games,4,inspect);
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/json-feature-config.json',JSON.stringify(results,null,2),'utf8');
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(results.map(r=>({
    game:r.game,
    ok:r.ok,
    endpoint:r.init?.endpoint||null,
    purchased_features:r.init?.purchased_features||[],
    relevant_docs:(r.docs||[]).map(d=>d.url),
    error:r.error||null,
  })),null,2),'utf8');

  console.log(JSON.stringify(results.map(r=>({
    game:r.game,
    ok:r.ok,
    purchased_features:r.init?.purchased_features||[],
    hits:(r.docs||[]).flatMap(d=>d.hits.map(h=>({
      source:d.url,
      path:h.path,
      value:h.value,
    }))).filter(h=>
      /(?:buy|purchas|chance|feature.*(?:price|cost|multiplier)|(?:price|cost|multiplier).*feature|super.*bonus|bonus.*(?:price|cost|multiplier))/i.test(h.path)
    ).slice(0,80),
    error:r.error||null,
  })),null,2));
}finally{
  await service.stop();
}
