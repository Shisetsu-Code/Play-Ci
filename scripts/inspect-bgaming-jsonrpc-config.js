import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const targets=[
 ['SugarMix','https://demo.bgaming-network.com/play/SugarMix/FUN'],
 ['YommiRush','https://demo.bgaming-network.com/play/YommiRush/FUN'],
 ['BigBucksSaloon','https://demo.bgaming-network.com/play/BigBucksSaloon/FUN'],
];
const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const parse=s=>{try{return JSON.parse(s)}catch{return null}};
const interesting=/buy|bonus|feature|chance|price|cost|multiplier|ante|free.?spin/i;

function walk(value,path='',depth=0,out=[]){
 if(depth>10||out.length>500)return out;
 if(Array.isArray(value)){
  value.slice(0,100).forEach((v,i)=>walk(v,path+'['+i+']',depth+1,out));
  return out;
 }
 if(!value||typeof value!=='object')return out;
 for(const [k,v] of Object.entries(value)){
  const p=path?path+'.'+k:k;
  if(interesting.test(k)){
   let sample=v;
   try{const s=JSON.stringify(v); sample=s.length>1000?s.slice(0,1000):v}catch{}
   out.push({path:p,value:sample});
  }
  if(v&&typeof v==='object')walk(v,p,depth+1,out);
 }
 return out;
}

await service.start();
try{
 const results=[];
 for(const [game,url] of targets){
  const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(s.id);
  try{
   await sleep(8000);
   const events=internal.recorder.eventsAfter(0);
   const documents=[];
   for(const ev of events){
    if(ev.type!=='responsebody'||!ev.body)continue;
    const body=parse(ev.body); if(!body)continue;
    const hits=walk(body);
    if(hits.length)documents.push({url:ev.url,keys:Object.keys(body),hits});
   }
   results.push({game,url,documents});
  }finally{await service.closeSession(s.id)}
 }
 await fs.mkdir('artifacts/bg-jsonrpc-config',{recursive:true});
 await fs.writeFile('artifacts/bg-jsonrpc-config/results.json',JSON.stringify(results,null,2),'utf8');
 console.log(JSON.stringify(results.map(r=>({game:r.game,documents:r.documents.map(d=>({url:d.url,hits:d.hits.slice(0,40)}))})),null,2));
}finally{await service.stop()}
