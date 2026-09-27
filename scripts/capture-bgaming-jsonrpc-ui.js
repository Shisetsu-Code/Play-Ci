import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractBgamingJsonRpcInit } from '../src/providers/bgaming.js';

const PROFILES={
  GatesOfPower:[
    {id:'boost',price:2,req:{purchased_feature:'buy_chance',buy_id:'boost'}},
    {id:'bonus-hunt',price:10,req:{purchased_feature:'buy_bonus_and_chance',buy_id:'bns'}},
    {id:'power-spins',price:90,req:{purchased_feature:'buy_chance',buy_id:'enhance'}},
    {id:'bonus',price:100,req:{purchased_feature:'buy_bonus',buy_id:'bonus'}},
    {id:'super',price:500,req:{purchased_feature:'buy_bonus',buy_id:'super'}},
  ],
  RecycleRiches:[
    {id:'chance-bet',price:2,req:{purchased_feature:'buy_chance',custom_field:'chance',bet_type:'bet'}},
    {id:'chance-default',price:2,req:{purchased_feature:'buy_chance',custom_field:'chance',bet_type:'default'}},
    {id:'buy-random-bet',price:100,req:{purchased_feature:'buy_bonus',custom_field:'buy_random',bet_type:'bet'}},
    {id:'buy-random-default',price:100,req:{purchased_feature:'buy_bonus',custom_field:'buy_random',bet_type:'default'}},
    {id:'buy-max-bet',price:300,req:{purchased_feature:'buy_bonus',custom_field:'buy_max',bet_type:'bet'}},
    {id:'buy-max-default',price:300,req:{purchased_feature:'buy_bonus',custom_field:'buy_max',bet_type:'default'}},
  ],
  TreasureExplorer:[
    {id:'chance',price:1.4,req:{purchased_feature:'buy_chance',machineId:6}},
    {id:'bonus',price:100,req:{purchased_feature:'buy_bonus',machineId:6}},
    {id:'super',price:250,req:{purchased_feature:'buy_bonus_and_chance',machineId:6}},
  ],
};

const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function parse(s){try{return JSON.parse(s)}catch{return null}}

async function waitInit(internal,timeout=12000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const init=extractBgamingJsonRpcInit(internal.recorder.eventsAfter(0));
    if(init)return init;
    await sleep(150);
  }
  return null;
}

function semanticHits(value,path='',depth=0,out=[]){
  if(value==null||depth>12||out.length>=80)return out;
  if(Array.isArray(value)){
    value.slice(0,80).forEach((v,i)=>semanticHits(v,path+'['+i+']',depth+1,out));
    return out;
  }
  if(typeof value!=='object')return out;
  for(const [k,v] of Object.entries(value)){
    const p=path?path+'.'+k:k;
    if(/purchas|buy_|buyId|feature|bonus|custom_field|machineId|baseBet|bet_type/i.test(k)){
      let sample=v;
      if(v&&typeof v==='object'){
        try{const s=JSON.stringify(v);sample=s.length<800?v:s.slice(0,800)}catch{sample=String(v)}
      }
      out.push({path:p,value:sample});
    }
    if(v&&typeof v==='object')semanticHits(v,p,depth+1,out);
  }
  return out;
}

async function openFresh(game){
  const session=await service.createSession({
    url:'https://demo.bgaming-network.com/play/'+game+'/FUN',
    skipSplash:false,
    captureInitialScreenshot:false,
  });
  const internal=service.sessions.get(session.id);
  const init=await waitInit(internal);
  if(!init){
    await service.closeSession(session.id);
    throw new Error('JSONRPC init not found');
  }
  const request=parse(init.request?.postData||'')||{};
  return {
    session,internal,init,
    token:request?.params?.token||null,
    result:init.body?.result||{},
  };
}

async function probe(task){
  let ctx;
  try{
    ctx=await openFresh(task.game);
    const cfg=ctx.result.config||{};
    const bet=(cfg.bet_limits||[])[0]??cfg.default_bet??100;
    const req={bet,...task.mode.req};
    const payload={
      id:crypto.randomUUID(),
      jsonrpc:'2.0',
      method:'play',
      params:{token:ctx.token,req},
    };
    if(ctx.result.state_lock)payload.params.state_lock=ctx.result.state_lock;
    const response=await ctx.internal.page.evaluate(async ({url,payload})=>{
      const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const text=await r.text();
      let body=null;try{body=JSON.parse(text)}catch{}
      return {status:r.status,body,text:text.slice(0,5000)};
    },{url:ctx.init.request.url,payload});
    const result=response.body?.result||null;
    return {
      game:task.game,id:task.mode.id,price:task.mode.price,request:req,
      accepted:Boolean(result)&&!response.body?.error,
      http_status:response.status,
      error:response.body?.error||null,
      final:result?.final??null,
      semantic_hits:semanticHits(result),
      result_keys:result?Object.keys(result):[],
      resp_keys:result?.resp&&typeof result.resp==='object'?Object.keys(result.resp):[],
    };
  }catch(error){
    return {game:task.game,id:task.mode.id,price:task.mode.price,request:task.mode.req,accepted:false,error:{message:error.message},semantic_hits:[]};
  }finally{
    if(ctx?.session)await service.closeSession(ctx.session.id).catch(()=>{});
  }
}

async function pool(items,limit,fn){
  const out=new Array(items.length);let cursor=0;
  async function worker(){while(true){const i=cursor++;if(i>=items.length)return;out[i]=await fn(items[i]);await sleep(250)}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return out;
}

await service.start();
try{
  const tasks=Object.entries(PROFILES).flatMap(([game,modes])=>modes.map(mode=>({game,mode})));
  const results=await pool(tasks,4,probe);
  const summary=[];
  for(const game of Object.keys(PROFILES)){
    const rows=results.filter(r=>r.game===game);
    summary.push({
      game,
      accepted:rows.filter(r=>r.accepted).map(r=>({id:r.id,price:r.price,request:r.request,final:r.final,semantic_hits:r.semantic_hits})),
      rejected:rows.filter(r=>!r.accepted).map(r=>({id:r.id,price:r.price,request:r.request,error:r.error})),
    });
  }
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/exact-profile-probe-2.json',JSON.stringify({profiles:PROFILES,results},null,2),'utf8');
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(summary,null,2),'utf8');
  console.log(JSON.stringify(summary,null,2));
}finally{await service.stop()}
