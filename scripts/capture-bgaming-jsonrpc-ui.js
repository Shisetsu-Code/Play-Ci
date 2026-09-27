import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractBgamingJsonRpcInit } from '../src/providers/bgaming.js';

const games=[
  'GrandPatron7rst',
  'RecycleRiches',
  'RocketEruptionTripleBlast',
  'StarTrekNextGen',
  'SweetSamurai',
  'TheGodfather3PillarsOfPower',
];
const terms=[
  'round_mode_id','rmid','custom_req','buy_mode',
  'isFeatureBuyFreeSpin','isFeatureBuyRespin',
  'deep_spin','deep_bonanza','BUY_BONUS_COSTS',
  'requestData','custom_field','purchaseFeaturesConfig',
  'purchased_feature','buy_bonus','buy_chance',
];
const service=new BrowserService({...config,maxBodyBytes:20*1024*1024,maxMemoryEvents:50000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function snippets(body,term,max=8){
  const out=[];
  const lower=body.toLowerCase(), needle=term.toLowerCase();
  let from=0;
  while(out.length<max){
    const at=lower.indexOf(needle,from);
    if(at<0)break;
    out.push(body.slice(Math.max(0,at-900),Math.min(body.length,at+term.length+1800)).replace(/\s+/g,' '));
    from=at+needle.length;
  }
  return out;
}

async function inspect(game){
  const url=`https://demo.bgaming-network.com/play/${game}/FUN?server=demo`;
  const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  try{
    await sleep(9000);
    await internal.recorder.waitForQuiet({quietMs:500,timeoutMs:3000}).catch(()=>{});
    const events=internal.recorder.eventsAfter(0);
    const init=extractBgamingJsonRpcInit(events);
    const hits=[];
    for(const e of events){
      if(e.type!=='responsebody'||typeof e.body!=='string'||e.body.length<80)continue;
      if(!/\.(?:js|mjs|json)(?:\?|$)/i.test(e.url||''))continue;
      const found=[];
      for(const term of terms){
        for(const snippet of snippets(e.body,term)) found.push({term,snippet});
      }
      if(found.length) hits.push({url:e.url,found:found.slice(0,80)});
      if(hits.length>=18)break;
    }
    return {
      game,url,ok:true,
      endpoint:init?.request?.url||null,
      config:init?.body?.result?.config||null,
      hits,
    };
  }catch(error){
    return {game,url,ok:false,error:error.message,hits:[]};
  }finally{
    await service.closeSession(session.id).catch(()=>{});
  }
}

await service.start();
try{
  const results=[];
  for(const game of games){
    results.push(await inspect(game));
    await sleep(250);
  }
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/final-wire-sources.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results.map(r=>({
    game:r.game,ok:r.ok,endpoint:r.endpoint,
    config:r.config?{
      default_bet:r.config.default_bet,
      bet_limits:r.config.bet_limits,
      purchased_features:r.config.purchased_features,
    }:null,
    sources:r.hits.map(s=>({
      url:s.url,
      terms:[...new Set(s.found.map(x=>x.term))],
      snippets:s.found.slice(0,24),
    })),
    error:r.error||null,
  })),null,2));
}finally{await service.stop()}
