import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractBgamingJsonRpcInit } from '../src/providers/bgaming.js';

const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const parse=s=>{try{return JSON.parse(s)}catch{return null}};

const MODES=[
  {id:'chance',feature:'buy_chance',custom_field:'chance',multiplier:2},
  {id:'buy_random',feature:'buy_bonus',custom_field:'buy_random',multiplier:100},
  {id:'buy_max',feature:'buy_bonus',custom_field:'buy_max',multiplier:300},
];

async function waitInit(internal,timeout=12000){
  const end=Date.now()+timeout;let best=null;
  while(Date.now()<end){
    const c=extractBgamingJsonRpcInit(internal.recorder.eventsAfter(0));
    if(c)best=c;
    if(c?.body?.result?.config?.bet_limits?.length)return c;
    await sleep(150);
  }
  return best;
}

async function probe(mode){
  let session=null;
  try{
    session=await service.createSession({
      url:'https://demo.bgaming-network.com/play/RecycleRiches/FUN?server=demo',
      skipSplash:false,captureInitialScreenshot:false,
    });
    const internal=service.sessions.get(session.id);
    const init=await waitInit(internal);
    if(!init)throw new Error('init missing');
    const initReq=parse(init.request?.postData||'')||{};
    const result=init.body?.result||{};
    const cfg=result.config||{};
    const base=(cfg.bet_limits||[])[0]??cfg.default_bet??100;
    const req={
      bet:base,
      custom_field:mode.custom_field,
      purchased_feature:mode.feature,
    };
    const payload={
      id:crypto.randomUUID(),jsonrpc:'2.0',method:'play',
      params:{token:initReq?.params?.token||null,req},
    };
    if(result.state_lock)payload.params.state_lock=result.state_lock;
    const response=await internal.page.evaluate(async ({endpoint,payload})=>{
      const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const text=await r.text();let body=null;try{body=JSON.parse(text)}catch{}
      return {status:r.status,body,text:text.slice(0,1800)};
    },{endpoint:init.request.url,payload});
    const res=response.body?.result||null;
    return {
      ...mode,base_bet:base,request:req,accepted:Boolean(res)&&!response.body?.error,
      error:response.body?.error||null,final:res?.final??null,
      result_keys:res?Object.keys(res):[],
      resp_keys:res?.resp&&typeof res.resp==='object'?Object.keys(res.resp):[],
    };
  }catch(error){
    return {...mode,accepted:false,error:{message:error.message}};
  }finally{
    if(session)await service.closeSession(session.id).catch(()=>{});
  }
}

await service.start();
try{
  const rows=[];
  for(const mode of MODES){rows.push(await probe(mode));await sleep(180)}
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/recycle-exact-wire.json',JSON.stringify(rows,null,2),'utf8');
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(rows,null,2),'utf8');
  console.log(JSON.stringify(rows,null,2));
}finally{await service.stop()}
