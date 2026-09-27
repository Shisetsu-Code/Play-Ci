import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractBgamingJsonRpcInit } from '../src/providers/bgaming.js';

const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const parse=s=>{try{return JSON.parse(s)}catch{return null}};

const TASKS=[
  // Recycle Riches wrapper: feature price is part of the wager passed to sendPlay.
  ...[
    ['RecycleRiches','chance',2,'buy_chance','chance'],
    ['RecycleRiches','random',100,'buy_bonus','buy_random'],
    ['RecycleRiches','max',300,'buy_bonus','buy_max'],
  ].flatMap(([game,id,mult,feature,custom_field])=>
    ['default','bet','betting'].map(bet_type=>({
      game,id:id+'-'+bet_type,mult,
      req:{purchased_feature:feature,custom_field,bet_type},
    }))
  ),

  // Star Trek: exact game request-map flags from customizeFeatureBuyRequestData.
  ...[
    ['fs',75,true,false],
    ['respin',30,false,true],
  ].flatMap(([id,mult,isFS,isRS])=>
    ['spin','SPIN'].map(action=>({
      game:'StarTrekNextGen',id:id+'-'+action,mult,
      req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{
        selectedWinLines:null,perLine:true,isFeatureBuyFreeSpin:isFS,isFeatureBuyRespin:isRS,
        action,exponent:2,stake:'<BET>',
      }},
    }))
  ),

  // Godfather: generic feature-buy marker plus game-specific normal/super discriminator.
  ...[
    ['normal',100,false],
    ['super',200,true],
  ].flatMap(([id,mult,isSuperBuy])=>
    ['spin','SPIN'].flatMap(action=>[
      {game:'TheGodfather3PillarsOfPower',id:id+'-full-'+action,mult,
       req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{isFeatureBuy:true,isSuperBuy,action,exponent:2}}},
      {game:'TheGodfather3PillarsOfPower',id:id+'-superonly-'+action,mult,
       req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{isSuperBuy,action,exponent:2}}},
    ])
  ),

  // Rocket: test the concrete common OGA discriminators with purchase-cost bet.
  ...[
    ['normal',100,false],
    ['super',200,true],
  ].flatMap(([id,mult,isSuper])=>[
    {game:'RocketEruptionTripleBlast',id:id+'-isSuper',mult,
     req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{isFeatureBuy:true,isSuperBuy:isSuper,action:'spin',exponent:2}}},
    {game:'RocketEruptionTripleBlast',id:id+'-buyMode',mult,
     req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{isFeatureBuy:true,buy_mode:id,action:'spin',exponent:2}}},
  ]),

  // Grand Patron modes from bets_data.json.
  ...[
    ['SHOP',100,'buy_bonus'],
    ['SHOP2',250,'buy_bonus'],
    ['SHOP3',1000,'buy_bonus'],
    ['ANTE',1.3,'buy_chance'],
  ].flatMap(([rmid,mult,feature])=>[
    {game:'GrandPatron7rst',id:'rmid-'+rmid,mult,req:{purchased_feature:feature,bet_type:'bet',rmid}},
    {game:'GrandPatron7rst',id:'custom-rmid-'+rmid,mult,req:{purchased_feature:feature,bet_type:'bet',custom_req:{rmid}}},
  ]),

  // Sweet Samurai local game identifiers.
  ...[
    ['deep_spin',100],
    ['deep_bonanza',150],
  ].flatMap(([mode,mult])=>[
    {game:'SweetSamurai',id:'custom-field-'+mode,mult,req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_field:mode}},
    {game:'SweetSamurai',id:'bonus-type-'+mode,mult,req:{purchased_feature:'buy_bonus',bet_type:'bet',bonus_type:mode}},
    {game:'SweetSamurai',id:'custom-mode-'+mode,mult,req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{mode,action:'spin',exponent:2}}},
  ]),
];

async function waitInit(internal,timeout=10000){
  const end=Date.now()+timeout; let best=null;
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
      url:'https://demo.bgaming-network.com/play/'+task.game+'/FUN?server=demo',
      skipSplash:false,captureInitialScreenshot:false,
    });
    const internal=service.sessions.get(session.id);
    const init=await waitInit(internal);
    if(!init)throw new Error('init missing');
    const initReq=parse(init.request?.postData||'')||{};
    const result=init.body?.result||{};
    const cfg=result.config||{};
    const base=(cfg.bet_limits||[])[0]??cfg.default_bet??100;
    const cost=Math.round(Number(base)*Number(task.mult));
    const replace=v=>{
      if(Array.isArray(v))return v.map(replace);
      if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)]));
      if(v==='<BET>')return cost;
      return v;
    };
    const req={bet:cost,...replace(task.req)};
    const payload={
      id:crypto.randomUUID(),jsonrpc:'2.0',method:'play',
      params:{token:initReq?.params?.token||null,req},
    };
    if(result.state_lock)payload.params.state_lock=result.state_lock;
    const endpoint=init.request?.url;
    const response=await internal.page.evaluate(async ({endpoint,payload})=>{
      try{
        const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        const text=await r.text(); let body=null; try{body=JSON.parse(text)}catch{}
        return {status:r.status,body,text:text.slice(0,1800)};
      }catch(error){return {status:null,error:error.message}}
    },{endpoint,payload});
    const res=response.body?.result||null;
    const error=response.body?.error||null;
    return {
      ...task,base_bet:base,request:req,accepted:Boolean(res)&&!error,
      http_status:response.status,error,
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
  for(const task of TASKS){
    rows.push(await probe(task));
    await sleep(120);
  }
  const byGame={};
  for(const row of rows)(byGame[row.game]??=[]).push(row);
  const summary=Object.entries(byGame).map(([game,items])=>({
    game,
    accepted:items.filter(x=>x.accepted).map(x=>({
      id:x.id,mult:x.mult,base_bet:x.base_bet,request:x.request,
      final:x.final,result_keys:x.result_keys,resp_keys:x.resp_keys,
    })),
    rejected:items.filter(x=>!x.accepted).map(x=>({id:x.id,error:x.error})),
  }));
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/purchase-cost-wire-probe.json',JSON.stringify(rows,null,2),'utf8');
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(summary,null,2),'utf8');
  console.log(JSON.stringify(summary,null,2));
}finally{
  await service.stop();
}
