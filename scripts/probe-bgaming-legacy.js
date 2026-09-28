import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractBgamingBootstrap } from '../src/providers/bgaming.js';

const url='https://demo.bgaming-network.com/play/BookOfCats/FUN?server=demo';
const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function fresh(){
  const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(s.id);
  const deadline=Date.now()+10000; let start=null;
  while(!start&&Date.now()<deadline){
    start=extractBgamingBootstrap(internal.recorder.eventsAfter(0));
    if(!start)await sleep(150);
  }
  if(!start){await service.closeSession(s.id);throw new Error('bootstrap missing')}
  return {s,internal,start};
}

function wallet(body){
  if(Number.isFinite(Number(body?.balance))) return Number(body.balance);
  return Number(body?.balance?.wallet);
}

async function probe(options){
  const {s,internal,start}=await fresh();
  try{
    const headers={'content-type':'application/json',referer:start.request?.headers?.referer||'https://demo.bgaming-network.com/'};
    if(start.request?.headers?.['x-csrf-token'])headers['x-csrf-token']=start.request.headers['x-csrf-token'];
    const payload={command:'spin',options};
    const res=await internal.context.request.post(start.request.url,{headers,data:JSON.stringify(payload),failOnStatusCode:false});
    const text=await res.text(); let body;try{body=JSON.parse(text)}catch{body={raw:text.slice(0,1000)}}
    const before=wallet(start.body),after=wallet(body);
    return {payload,http:res.status(),before,after,cost:Number.isFinite(before)&&Number.isFinite(after)?before-after:null,response:body};
  }finally{await service.closeSession(s.id);await sleep(200)}
}

await service.start();
try{
 const cases=[
   ['spin10',{bet:10}],
   ['spin20',{bet:20}],
   ['freespin_buy',{bet:10,purchased_feature:'freespin_buy'}],
   ['freespin_buy_l0',{bet:10,purchased_feature:'freespin_buy',purchased_feature_level:'0'}],
   ['freespin_buy_l1',{bet:10,purchased_feature:'freespin_buy',purchased_feature_level:'1'}],
   ['bonus_buy',{bet:10,purchased_feature:'bonus_buy'}],
   ['buy_feature',{bet:10,purchased_feature:'buy_feature'}],
   ['buy_bonus',{bet:10,purchased_feature:'buy_bonus'}],
 ];
 const results=[];
 for(const [name,options] of cases)results.push({name,...await probe(options)});
 await fs.mkdir('artifacts/bg-legacy-probe',{recursive:true});
 await fs.writeFile('artifacts/bg-legacy-probe/results.json',JSON.stringify(results,null,2),'utf8');
 console.log(JSON.stringify(results.map(r=>({name:r.name,http:r.http,cost:r.cost,errors:r.response?.errors||null,game:r.response?.game||null,available:r.response?.available_commands||null})),null,2));
}finally{await service.stop()}
