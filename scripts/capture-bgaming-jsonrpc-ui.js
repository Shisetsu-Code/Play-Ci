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

const TERMS=[
  'purchased_feature',
  'feature_id',
  'featureId',
  'buy_id',
  'bonus_buy',
  'bonus_multiplier_type',
  'machineId',
  'buyFeatureById',
  'buyFeatures',
  'buy_features',
  'buyBonusFeatures',
];

const service=new BrowserService({
  ...config,
  maxBodyBytes:10*1024*1024,
  maxMemoryEvents:35000,
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function cleanSnippet(text){
  return text.replace(/\s+/g,' ').trim();
}

function snippetsFor(body,term,max=5){
  const out=[];
  let from=0;
  const needle=term.toLowerCase();
  const lower=body.toLowerCase();
  while(out.length<max){
    const i=lower.indexOf(needle,from);
    if(i<0)break;
    out.push(cleanSnippet(body.slice(Math.max(0,i-550),Math.min(body.length,i+term.length+950))));
    from=i+term.length;
  }
  return out;
}

function likelyCode(url,body){
  if(!body || typeof body!=='string')return false;
  if(/\.(?:js|mjs)(?:\?|$)/i.test(url))return true;
  return body.length>1000 && /(?:function|=>|class |purchased_feature|feature_id|buy_id|bonus_buy)/i.test(body);
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
    const sources=[];

    for(const event of events){
      if(event.type!=='responsebody'||!likelyCode(event.url||'',event.body))continue;
      const hits=[];
      for(const term of TERMS){
        const snippets=snippetsFor(event.body,term);
        for(const snippet of snippets)hits.push({term,snippet});
      }
      if(hits.length){
        sources.push({
          url:event.url,
          bytes:Buffer.byteLength(event.body),
          hits:hits.slice(0,36),
        });
      }
      if(sources.length>=25)break;
    }

    return {
      game,url,ok:true,final_url:internal.page.url(),
      init:{
        endpoint:init?.request?.url||null,
        purchased_features:init?.body?.result?.config?.purchased_features||[],
        bet_limits:init?.body?.result?.config?.bet_limits||[],
        default_bet:init?.body?.result?.config?.default_bet??null,
        state_lock:init?.body?.result?.state_lock??null,
      },
      sources,
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
      if(i>=items.length)return;
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
  await fs.writeFile('artifacts/bg-jsonrpc-ui/wire-callsites.json',JSON.stringify(results,null,2),'utf8');
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(results.map(r=>({
    game:r.game,
    ok:r.ok,
    endpoint:r.init?.endpoint||null,
    purchased_features:r.init?.purchased_features||[],
    sources:r.sources?.map(s=>s.url)||[],
    error:r.error||null,
  })),null,2),'utf8');

  const summary=results.map(r=>({
    game:r.game,
    ok:r.ok,
    purchased_features:r.init?.purchased_features||[],
    callsites:(r.sources||[]).flatMap(s=>s.hits.map(h=>({
      source:s.url.split('/').pop()?.split('?')[0]||s.url,
      term:h.term,
      snippet:h.snippet,
    }))).filter((x,i,a)=>
      i===a.findIndex(y=>y.term===x.term&&y.snippet===x.snippet)
    ).slice(0,14),
    error:r.error||null,
  }));
  console.log(JSON.stringify(summary,null,2));
}finally{
  await service.stop();
}
