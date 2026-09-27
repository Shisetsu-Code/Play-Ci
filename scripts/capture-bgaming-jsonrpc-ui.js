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

function parseJson(text){
  try{return JSON.parse(text)}catch{return null}
}

function collectJsonRpcConfig(init){
  const cfg=init?.body?.result?.config||{};
  return {
    bet_limits:cfg.bet_limits||[],
    default_bet:cfg.default_bet??null,
    purchased_features:Array.isArray(cfg.purchased_features)?cfg.purchased_features:[],
    config_keys:Object.keys(cfg).sort(),
  };
}

function interestingStrings(body){
  const out=new Set();
  const patterns=[
    /["'`]((?:buy|bonus|freespin|free_spin|chance|feature)[A-Za-z0-9_-]{0,80})["'`]/gi,
    /["'`]([A-Za-z0-9_-]{0,40}(?:buy|bonus|freespin|free_spin|chance|feature)[A-Za-z0-9_-]{0,40})["'`]/gi,
    /["'`]((?:freeSpin|buyBonus|bonusMultiplier|featureId)[A-Za-z0-9_-]{0,80})["'`]/g,
  ];
  for(const regex of patterns){
    let match;
    while((match=regex.exec(body))!==null){
      const value=match[1];
      if(value.length>=3&&value.length<=100) out.add(value);
      if(out.size>=300) break;
    }
  }
  return [...out].sort();
}

function markerSnippets(body){
  const markers=['purchased_feature','feature_id','featureId','bonus_multiplier_type','buy_super_bonus','buy_ultra_bonus','freeSpinRandom'];
  const snippets=[];
  for(const marker of markers){
    let from=0;
    while(snippets.length<80){
      const idx=body.indexOf(marker,from);
      if(idx<0) break;
      const start=Math.max(0,idx-180);
      const end=Math.min(body.length,idx+marker.length+260);
      snippets.push({marker,snippet:body.slice(start,end)});
      from=idx+marker.length;
    }
  }
  return snippets;
}

async function inspect(game){
  const url=`https://demo.bgaming-network.com/play/${game}/FUN`;
  const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  try{
    await sleep(6500);
    await internal.recorder.waitForQuiet({quietMs:500,timeoutMs:2500}).catch(()=>{});
    const events=internal.recorder.eventsAfter(0);
    const init=extractBgamingJsonRpcInit(events);
    const sources=[];
    const tokenUnion=new Set();

    for(const event of events){
      if(event.type!=='responsebody'||typeof event.body!=='string'||!event.body) continue;
      const body=event.body;
      const tokens=interestingStrings(body);
      const snippets=markerSnippets(body);
      if(tokens.length===0&&snippets.length===0) continue;
      for(const token of tokens) tokenUnion.add(token);
      sources.push({
        url:event.url,
        bytes:Buffer.byteLength(body),
        content_json:Boolean(parseJson(body)),
        tokens,
        snippets,
      });
      if(sources.length>=80) break;
    }

    return {
      game,url,ok:true,
      final_url:internal.page.url(),
      init:collectJsonRpcConfig(init),
      extracted_tokens:[...tokenUnion].sort(),
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
      const index=cursor++;
      if(index>=items.length)return;
      out[index]=await fn(items[index]);
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
  await fs.writeFile('artifacts/bg-jsonrpc-ui/asset-feature-scan.json',JSON.stringify(results,null,2),'utf8');
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(results.map(r=>({
    game:r.game,
    ok:r.ok,
    final_url:r.final_url||null,
    purchased_features:r.init?.purchased_features||[],
    extracted_tokens:r.extracted_tokens||[],
    source_count:r.sources?.length||0,
    error:r.error||null,
  })),null,2),'utf8');

  console.log(JSON.stringify(results.map(r=>({
    game:r.game,
    ok:r.ok,
    purchased_features:r.init?.purchased_features||[],
    extracted_tokens:(r.extracted_tokens||[]).filter(x=>
      /buy|chance|feature_id|featureId|freeSpinRandom|super_bonus|ultra_bonus/i.test(x)
    ).slice(0,80),
    marker_sources:(r.sources||[]).filter(s=>s.snippets?.length).map(s=>s.url).slice(0,12),
    error:r.error||null,
  })),null,2));
}finally{
  await service.stop();
}
