import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractBgamingJsonRpcInit } from '../src/providers/bgaming.js';

const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const CASES={
  RecycleRiches:[
    ...['default','bet','betting'].flatMap(bet_type=>[
      {id:'chance-'+bet_type,req:{purchased_feature:'buy_chance',custom_field:'chance',bet_type}},
      {id:'random-'+bet_type,req:{purchased_feature:'buy_bonus',custom_field:'buy_random',bet_type}},
      {id:'max-'+bet_type,req:{purchased_feature:'buy_bonus',custom_field:'buy_max',bet_type}},
    ]),
  ],
  StarTrekNextGen:[
    ...['spin','SPIN'].flatMap(action=>[
      {id:'fs-'+action,req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{
        selectedWinLines:null,perLine:true,isFeatureBuyFreeSpin:true,isFeatureBuyRespin:false,
        action,exponent:2,stake:'<BET>',
      }}},
      {id:'respin-'+action,req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{
        selectedWinLines:null,perLine:true,isFeatureBuyFreeSpin:false,isFeatureBuyRespin:true,
        action,exponent:2,stake:'<BET>',
      }}},
    ]),
  ],
  TheGodfather3PillarsOfPower:[
    ...['spin','SPIN'].flatMap(action=>[
      {id:'normal-'+action,req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{isSuperBuy:false,action,exponent:2}}},
      {id:'super-'+action,req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{isSuperBuy:true,action,exponent:2}}},
    ]),
  ],
  RocketEruptionTripleBlast:[
    ...['spin','SPIN'].flatMap(action=>[
      {id:'normal-buymode-'+action,req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{buy_mode:'normal',action,exponent:2}}},
      {id:'super-buymode-'+action,req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{buy_mode:'super',action,exponent:2}}},
      {id:'normal-superflag-'+action,req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{isSuperBuy:false,action,exponent:2}}},
      {id:'super-superflag-'+action,req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{isSuperBuy:true,action,exponent:2}}},
      {id:'fs-'+action,req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{isFeatureBuyFreeSpin:true,isFeatureBuyRespin:false,action,exponent:2}}},
      {id:'respin-'+action,req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{isFeatureBuyFreeSpin:false,isFeatureBuyRespin:true,action,exponent:2}}},
    ]),
  ],
  GrandPatron7rst:[
    ...['SHOP','SHOP2','SHOP3','ANTE'].flatMap(rmid=>[
      {id:'root-rmid-'+rmid,req:{purchased_feature:rmid==='ANTE'?'buy_chance':'buy_bonus',bet_type:'bet',rmid}},
      {id:'custom-rmid-'+rmid,req:{purchased_feature:rmid==='ANTE'?'buy_chance':'buy_bonus',bet_type:'bet',custom_req:{rmid}}},
      {id:'round-mode-'+rmid,req:{purchased_feature:rmid==='ANTE'?'buy_chance':'buy_bonus',bet_type:'bet',round_mode_id:rmid}},
      {id:'custom-field-'+rmid,req:{purchased_feature:rmid==='ANTE'?'buy_chance':'buy_bonus',bet_type:'bet',custom_field:rmid}},
    ]),
  ],
  SweetSamurai:[
    ...['deep_spin','deep_bonanza'].flatMap(mode=>[
      {id:'custom-field-'+mode,req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_field:mode}},
      {id:'bonus-type-'+mode,req:{purchased_feature:'buy_bonus',bet_type:'bet',bonus_type:mode}},
      {id:'custom-bonusType-'+mode,req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{bonusType:mode,action:'spin',exponent:2}}},
      {id:'custom-mode-'+mode,req:{purchased_feature:'buy_bonus',bet_type:'bet',custom_req:{mode,action:'spin',exponent:2}}},
      {id:'feature-as-mode-'+mode,req:{purchased_feature:mode,bet_type:'bet'}},
    ]),
  ],
};

function parse(s){try{return JSON.parse(s)}catch{return null}}

async function waitInit(internal,timeout=12000){
  const end=Date.now()+timeout;
  let best=null;
  while(Date.now()<end){
    const candidate=extractBgamingJsonRpcInit(internal.recorder.eventsAfter(0));
    if(candidate)best=candidate;
    if(candidate?.body?.result?.config?.bet_limits?.length)return candidate;
    await sleep(180);
  }
  return best;
}

async function openFresh(game){
  const session=await service.createSession({
    url:'https://demo.bgaming-network.com/play/'+game+'/FUN?server=demo',
    skipSplash:false,captureInitialScreenshot:false,
  });
  const internal=service.sessions.get(session.id);
  const init=await waitInit(internal);
  if(!init){await service.closeSession(session.id);throw new Error('init missing')}
  const initReq=parse(init.request?.postData||'')||{};
  return {session,internal,init,result:init.body?.result||{},token:initReq?.params?.token||null};
}

async function probe(game,candidate){
  let ctx=null;
  try{
    ctx=await openFresh(game);
    const cfg=ctx.result.config||{};
    const bet=(cfg.bet_limits||[])[0]??cfg.default_bet??100;
    const exponent=Number(ctx.result.currency_attributes?.exponent ?? 2);
    const replace=(v)=>{
      if(Array.isArray(v))return v.map(replace);
      if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)]));
      if(v==='<BET>')return bet;
      if(v==='<EXPONENT>')return exponent;
      return v;
    };
    const req={bet,...replace(candidate.req)};
    const payload={id:crypto.randomUUID(),jsonrpc:'2.0',method:'play',params:{token:ctx.token,req}};
    if(ctx.result.state_lock)payload.params.state_lock=ctx.result.state_lock;
    const endpoint=ctx.init.request?.url;
    const response=await ctx.internal.page.evaluate(async ({endpoint,payload})=>{
      try{
        const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        const text=await r.text();let body=null;try{body=JSON.parse(text)}catch{}
        return {status:r.status,body,text:text.slice(0,2500)};
      }catch(error){return {status:null,error:error.message}}
    },{endpoint,payload});
    const result=response.body?.result||null;
    const error=response.body?.error||null;
    return {
      game,id:candidate.id,accepted:Boolean(result)&&!error,request:req,
      http_status:response.status,error,
      result_keys:result?Object.keys(result):[],
      resp_keys:result?.resp&&typeof result.resp==='object'?Object.keys(result.resp):[],
      final:result?.final??null,
    };
  }catch(error){
    return {game,id:candidate.id,accepted:false,error:{message:error.message}};
  }finally{
    if(ctx?.session)await service.closeSession(ctx.session.id).catch(()=>{});
  }
}

await service.start();
try{
  const reports=[];
  for(const [game,candidates] of Object.entries(CASES)){
    const rows=[];
    for(const candidate of candidates){
      const row=await probe(game,candidate);
      rows.push(row);
      if(row.accepted){
        // Once each semantic branch is proven, keep a little evidence but don't spam the provider.
        const prefix=candidate.id.split('-')[0];
        if(['chance','random','max','fs','respin','normal','super','root','custom','round','feature'].includes(prefix)){
          // continue because a second mode may still need proof
        }
      }
      await sleep(180);
    }
    reports.push({game,rows});
    await sleep(350);
  }
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/direct-final-wire-probe.json',JSON.stringify(reports,null,2),'utf8');
  const summary=reports.map(r=>({
    game:r.game,
    accepted:r.rows.filter(x=>x.accepted).map(x=>({id:x.id,request:x.request,final:x.final,result_keys:x.result_keys,resp_keys:x.resp_keys})),
    rejected:r.rows.filter(x=>!x.accepted).map(x=>({id:x.id,error:x.error})),
  }));
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(summary,null,2),'utf8');
  console.log(JSON.stringify(summary,null,2));
}finally{await service.stop()}
