import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractBgamingJsonRpcInit } from '../src/providers/bgaming.js';

const games=['YommiRush','SugarMix','ChickenFire','BlackbeardsBounty','MultiRush'];
const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function parse(text){try{return JSON.parse(text)}catch{return null}}

async function waitInit(internal,timeout=10000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const init=extractBgamingJsonRpcInit(internal.recorder.eventsAfter(0));
    if(init)return init;
    await sleep(150);
  }
  return null;
}

async function fresh(game){
  const url=`https://demo.bgaming-network.com/play/${game}/FUN`;
  const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  const init=await waitInit(internal);
  if(!init)throw new Error('JSONRPC init not found');
  const request=parse(init.request?.postData||'')||{};
  const result=init.body?.result||{};
  return {session,internal,init,token:request?.params?.token||null,result};
}

async function play(internal,endpoint,payload){
  return internal.page.evaluate(async ({endpoint,payload})=>{
    try{
      const response=await fetch(endpoint,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload),
      });
      const text=await response.text();
      let body=null;
      try{body=JSON.parse(text)}catch{}
      return {http_status:response.status,ok:response.ok,body,text:text.slice(0,4000)};
    }catch(error){
      return {http_status:null,ok:false,error:error.message};
    }
  },{endpoint,payload});
}

async function probeOne(game,feature){
  let ctx=null;
  try{
    ctx=await fresh(game);
    const endpoint=ctx.init.request?.url;
    const cfg=ctx.result.config||{};
    const bet=(cfg.bet_limits||[])[0]??cfg.default_bet??100;
    const before=Number(ctx.result.balance);
    const req={bet,bet_type:'bet',purchased_feature:feature};
    const payload={
      id:crypto.randomUUID(),
      jsonrpc:'2.0',
      method:'play',
      params:{token:ctx.token,req},
    };
    if(ctx.result.state_lock)payload.params.state_lock=ctx.result.state_lock;
    const response=await play(ctx.internal,endpoint,payload);
    const result=response.body?.result||null;
    const error=response.body?.error||null;
    const after=Number(result?.balance);
    const delta=Number.isFinite(before)&&Number.isFinite(after)?before-after:null;
    return {
      game,feature,bet,endpoint,
      accepted:Boolean(result)&&!error,
      http_status:response.http_status,
      error,
      final:result?.final??null,
      balance_before:Number.isFinite(before)?before:null,
      balance_after:Number.isFinite(after)?after:null,
      cost:delta,
      multiplier:Number.isFinite(delta)&&Number(bet)>0?delta/Number(bet):null,
      response_keys:result?Object.keys(result):[],
      resp_keys:result?.resp&&typeof result.resp==='object'?Object.keys(result.resp):[],
    };
  }catch(error){
    return {game,feature,accepted:false,error:{message:error.message}};
  }finally{
    if(ctx?.session)await service.closeSession(ctx.session.id).catch(()=>{});
  }
}

async function probeGame(game){
  let ctx=null;
  try{
    ctx=await fresh(game);
    const features=Array.isArray(ctx.result.config?.purchased_features)
      ? [...ctx.result.config.purchased_features]
      : [];
    await service.closeSession(ctx.session.id);
    ctx=null;

    const results=[];
    for(const feature of features){
      results.push(await probeOne(game,String(feature)));
      await sleep(250);
    }
    return {game,features,results};
  }catch(error){
    if(ctx?.session)await service.closeSession(ctx.session.id).catch(()=>{});
    return {game,error:error.message,features:[],results:[]};
  }
}

await service.start();
try{
  const reports=[];
  for(const game of games){
    reports.push(await probeGame(game));
    await sleep(500);
  }
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/direct-feature-probe.json',JSON.stringify(reports,null,2),'utf8');
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(reports.map(r=>({
    game:r.game,
    declared:r.features,
    accepted:r.results.filter(x=>x.accepted).map(x=>({
      feature:x.feature,
      final:x.final,
      cost:x.cost,
      multiplier:x.multiplier,
    })),
    rejected:r.results.filter(x=>!x.accepted).map(x=>({
      feature:x.feature,
      code:x.error?.code??null,
      message:x.error?.message??x.error?.data?.message??null,
    })),
    error:r.error||null,
  })),null,2),'utf8');
  console.log(JSON.stringify(reports.map(r=>({
    game:r.game,
    declared:r.features,
    accepted:r.results.filter(x=>x.accepted).map(x=>({
      feature:x.feature,
      final:x.final,
      cost:x.cost,
      multiplier:x.multiplier,
    })),
    rejected:r.results.filter(x=>!x.accepted).map(x=>({
      feature:x.feature,
      error:x.error,
    })),
    error:r.error||null,
  })),null,2));
}finally{
  await service.stop();
}
