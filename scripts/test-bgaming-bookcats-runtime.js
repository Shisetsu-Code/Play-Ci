import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import {
  extractBgamingBootstrap,
  summarizeBgamingBootstrap,
  buildBgamingExecutionBlueprints,
} from '../src/providers/bgaming.js';

const URL='https://demo.bgaming-network.com/play/BookOfCatsMegaways/FUN?server=demo';
const service=new BrowserService(config);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

function walletValue(body) {
  const wallet=Number(body?.balance?.wallet);
  return Number.isFinite(wallet) ? wallet : null;
}

async function fresh() {
  const s=await service.createSession({
    url:URL,
    skipSplash:false,
    captureInitialScreenshot:false,
  });
  const internal=service.sessions.get(s.id);
  const deadline=Date.now()+10000;
  let start=null;

  while(!start && Date.now()<deadline){
    start=extractBgamingBootstrap(internal.recorder.eventsAfter(0));
    if(!start) await sleep(150);
  }

  if(!start){
    await service.closeSession(s.id);
    throw new Error('bootstrap missing');
  }

  const protocol=summarizeBgamingBootstrap(start);
  return {s,internal,start,protocol};
}

async function executeCase(name, blueprint, expectedMultiplier) {
  const {s,internal,start,protocol}=await fresh();
  try {
    const bet=protocol.default_bet_raw;
    const options={...blueprint.request_template.options,bet};
    const headers={
      'content-type':'application/json',
      referer:start.request?.headers?.referer || 'https://demo.bgaming-network.com/',
    };
    const csrf=start.request?.headers?.['x-csrf-token'];
    if(csrf) headers['x-csrf-token']=csrf;

    const payload={command:'spin',options};
    const response=await internal.context.request.post(start.request.url,{
      headers,
      data:JSON.stringify(payload),
      failOnStatusCode:false,
    });

    const text=await response.text();
    let body=null;
    try { body=JSON.parse(text); }
    catch { body={raw:text.slice(0,4000)}; }

    const beforeWallet=walletValue(start.body);
    const afterWallet=walletValue(body);
    const costRaw=Number.isFinite(beforeWallet)&&Number.isFinite(afterWallet)
      ? beforeWallet-afterWallet
      : null;
    const ratio=Number.isFinite(costRaw)&&Number(bet)>0
      ? costRaw/Number(bet)
      : null;

    const http=response.status();
    const errors=body?.errors ?? body?.error ?? null;
    const accepted=http>=200&&http<300&&!errors;
    const ratioMatches=Number.isFinite(ratio)
      ? Math.abs(ratio-expectedMultiplier)<1e-9
      : null;

    const expectedFeature=blueprint.feature||null;
    const observedFeature=body?.flow?.purchased_feature?.name ?? null;
    const featureMatches=expectedFeature
      ? observedFeature===expectedFeature
      : observedFeature==null;

    const flowCommandMatches=body?.flow?.command==='spin';
    const semanticMatch=flowCommandMatches&&featureMatches;

    return {
      name,
      kind:blueprint.kind,
      feature:expectedFeature,
      expected_multiplier:expectedMultiplier,
      bet_raw:bet,
      payload,
      endpoint:start.request.url,
      http_status:http,
      accepted,
      before_wallet:beforeWallet,
      after_wallet:afterWallet,
      game_balance:Number(body?.balance?.game ?? 0),
      cost_raw:costRaw,
      observed_multiplier:ratio,
      multiplier_match:ratioMatches,
      observed_feature:observedFeature,
      feature_match:featureMatches,
      flow_command_match:flowCommandMatches,
      semantic_match:semanticMatch,
      verdict: accepted && ratioMatches===true && semanticMatch
        ? 'PASS'
        : accepted && ratioMatches===null && semanticMatch
          ? 'ACCEPTED_COST_UNKNOWN'
          : accepted
            ? 'MISMATCH'
            : 'REJECTED',
      response_keys:body&&typeof body==='object'?Object.keys(body):[],
      errors,
      flow:body?.flow??null,
      response:body,
    };
  } finally {
    await service.closeSession(s.id);
    await sleep(250);
  }
}

await service.start();
try {
  const {s,protocol}=await fresh();
  await service.closeSession(s.id);

  const blueprints=buildBgamingExecutionBlueprints(protocol);
  const wanted=[
    {id:'spin',multiplier:1},
    {id:'freespin_chance:fixed',multiplier:1.5},
    {id:'freespin_buy:fixed',multiplier:100},
    {id:'high_freespin_buy:fixed',multiplier:150},
  ];

  const results=[];
  for(const item of wanted){
    const bp=blueprints.find(x=>x.id===item.id);
    if(!bp){
      results.push({
        name:item.id,
        expected_multiplier:item.multiplier,
        verdict:'BLUEPRINT_MISSING'
      });
      continue;
    }
    results.push(await executeCase(item.id,bp,item.multiplier));
  }

  const summary={
    url:URL,
    generation:protocol.generation,
    default_bet_raw:protocol.default_bet_raw,
    default_bet_display:protocol.default_bet_display,
    declared_special_modes:protocol.special_modes,
    blueprints:blueprints.map(x=>({
      id:x.id,
      kind:x.kind,
      feature:x.feature||null,
      declared_multiplier:x.declared_multiplier??1,
      request_template:x.request_template,
    })),
    results:results.map(r=>({
      name:r.name,
      verdict:r.verdict,
      http_status:r.http_status??null,
      accepted:r.accepted??false,
      expected_multiplier:r.expected_multiplier,
      observed_multiplier:r.observed_multiplier??null,
      multiplier_match:r.multiplier_match??null,
      expected_feature:r.feature??null,
      observed_feature:r.observed_feature??null,
      feature_match:r.feature_match??null,
      semantic_match:r.semantic_match??null,
      cost_raw:r.cost_raw??null,
      game_balance:r.game_balance??null,
      errors:r.errors??null,
    })),
    all_pass:results.length===4&&results.every(r=>r.verdict==='PASS'),
  };

  await fs.mkdir('artifacts/bookcats-runtime',{recursive:true});
  await fs.writeFile(
    'artifacts/bookcats-runtime/report.json',
    JSON.stringify({summary,results},null,2),
    'utf8'
  );
  await fs.writeFile(
    'artifacts/bookcats-runtime/summary.json',
    JSON.stringify(summary,null,2),
    'utf8'
  );

  console.log(JSON.stringify(summary,null,2));

  if(!summary.all_pass){
    process.exitCode=2;
  }
} finally {
  await service.stop();
}
