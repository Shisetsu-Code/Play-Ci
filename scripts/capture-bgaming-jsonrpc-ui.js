import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractBgamingJsonRpcInit } from '../src/providers/bgaming.js';

const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const parse=s=>{try{return JSON.parse(s)}catch{return null}};

const TASKS=[
  ...[
    ['normal',100,true],
    ['super',200,false],
  ].flatMap(([id,mult,isNormalBuy])=>
    ['spin','SPIN'].flatMap(action=>[
      {id:id+'-full-'+action,mult,custom_req:{isFeatureBuy:true,isNormalBuy,action,exponent:2}},
      {id:id+'-normalflag-'+action,mult,custom_req:{isNormalBuy,action,exponent:2}},
    ])
  ),
];

async function waitInit(internal,timeout=10000){
  const end=Date.now()+timeout;let best=null;
  while(Date.now()<end){
    const c=extractBgamingJsonRpcInit(internal.recorder.eventsAfter(0));
    if(c)best=c;
    if(c?.body?.result?.config?.bet_limits?.length)return c;
    await sleep(150);
  }
  return best;
}

async function probe(task){
  let session=null;
  try{
    session=await service.createSession({
      url:'https://demo.bgaming-network.com/play/RocketEruptionTripleBlast/FUN?server=demo',
      skipSplash:false,captureInitialScreenshot:false,
    });
    const internal=service.sessions.get(session.id);
    const init=await waitInit(internal);
    if(!init)throw new Error('init missing');
    const initReq=parse(init.request?.postData||'')||{};
    const result=init.body?.result||{};
    const cfg=result.config||{};
    const base=(cfg.bet_limits||[])[0]??cfg.default_bet??100;
    const bet=Math.round(Number(base)*task.mult);
    const req={
      bet,
      bet_type:'bet',
      purchased_feature:'buy_bonus',
      custom_req:task.custom_req,
    };
    const payload={
      id:crypto.randomUUID(),jsonrpc:'2.0',method:'play',
      params:{token:initReq?.params?.token||null,req},
    };
    if(result.state_lock)payload.params.state_lock=result.state_lock;
    const endpoint=init.request?.url;
    const response=await internal.page.evaluate(async ({endpoint,payload})=>{
      const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const text=await r.text();let body=null;try{body=JSON.parse(text)}catch{}
      return {status:r.status,body,text:text.slice(0,1800)};
    },{endpoint,payload});
    const res=response.body?.result||null;
    return {
      ...task,base_bet:base,request:req,
      accepted:Boolean(res)&&!response.body?.error,
      error:response.body?.error||null,
      final:res?.final??null,
      result_keys:res?Object.keys(res):[],
      resp_keys:res?.resp&&typeof res.resp==='object'?Object.keys(res.resp):[],
    };
  }catch(error){
    return {...task,accepted:false,error:{message:error.message}};
  }finally{
    if(session)await service.closeSession(session.id).catch(()=>{});
  }
}

await service.start();
try{
  const rows=[];
  for(const task of TASKS){rows.push(await probe(task));await sleep(150)}
  const summary={
    game:'RocketEruptionTripleBlast',
    accepted:rows.filter(x=>x.accepted),
    rejected:rows.filter(x=>!x.accepted).map(x=>({id:x.id,error:x.error})),
  };
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/rocket-wire-probe.json',JSON.stringify(rows,null,2),'utf8');
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(summary,null,2),'utf8');
  console.log(JSON.stringify(summary,null,2));
}finally{await service.stop()}
