import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractBgamingJsonRpcInit } from '../src/providers/bgaming.js';
import { extractBgamingJsonRpcStaticProfile } from '../src/providers/bgaming-jsonrpc-static.js';

const games=[
  'BlingBlitzDiamondDrop',
  'GrandPatron7rst',
  'HotRocket532',
  'JewelBoom',
  'ZeusGoesWild',
];
const service=new BrowserService({
  ...config,
  maxBodyBytes:20*1024*1024,
  maxMemoryEvents:50000,
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function waitInit(internal,timeout=12000){
  const deadline=Date.now()+timeout;
  let best=null;
  while(Date.now()<deadline){
    const candidate=extractBgamingJsonRpcInit(internal.recorder.eventsAfter(0));
    if(candidate)best=candidate;
    if(candidate?.body?.result?.config?.bet_limits?.length) return candidate;
    await sleep(200);
  }
  return best;
}

function score(profile){
  return (profile?.catalog_complete?1000:0)+(profile?.wire_complete?100:0)+(profile?.modes?.length||0)*10;
}

async function inspect(game){
  const url=`https://demo.bgaming-network.com/play/${game}/FUN?server=demo`;
  const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  try{
    const init=await waitInit(internal);
    const deadline=Date.now()+8000;
    let best=extractBgamingJsonRpcStaticProfile(internal.recorder.eventsAfter(0));
    while(Date.now()<deadline && !best?.catalog_complete){
      await sleep(300);
      const p=extractBgamingJsonRpcStaticProfile(internal.recorder.eventsAfter(0));
      if(score(p)>score(best))best=p;
    }
    return {
      game,
      init_found:Boolean(init),
      bet_limits:init?.body?.result?.config?.bet_limits||[],
      purchased_features:init?.body?.result?.config?.purchased_features||[],
      profile:best,
    };
  }catch(error){
    return {game,error:error.message};
  }finally{
    await service.closeSession(session.id).catch(()=>{});
  }
}

await service.start();
try{
  const results=[];
  for(const game of games){
    results.push(await inspect(game));
    await sleep(300);
  }
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/final-five-parser.json',JSON.stringify(results,null,2),'utf8');
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(results.map(r=>({
    game:r.game,
    init_found:r.init_found||false,
    bet_count:r.bet_limits?.length||0,
    capability_count:r.purchased_features?.length||0,
    profile_source:r.profile?.source||null,
    catalog_complete:Boolean(r.profile?.catalog_complete),
    wire_complete:Boolean(r.profile?.wire_complete),
    modes:(r.profile?.modes||[]).map(m=>({
      kind:m.kind,id:m.id,feature:m.feature,multiplier:m.multiplier,
      wire_complete:m.wire_complete,
    })),
    error:r.error||null,
  })),null,2),'utf8');
  console.log(JSON.stringify(results.map(r=>({
    game:r.game,
    init_found:r.init_found||false,
    bet_count:r.bet_limits?.length||0,
    profile_source:r.profile?.source||null,
    catalog_complete:Boolean(r.profile?.catalog_complete),
    wire_complete:Boolean(r.profile?.wire_complete),
    modes:(r.profile?.modes||[]).map(m=>[m.kind,m.id,m.feature,m.multiplier,m.wire_complete]),
    error:r.error||null,
  })),null,2));
}finally{
  await service.stop();
}
