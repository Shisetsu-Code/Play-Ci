import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const targets=[
  ['wild-dice','https://demo.bgaming-network.com/play/AztecsClawWildDice/FUN'],
  ['sugar-mix','https://demo.bgaming-network.com/play/SugarMix/FUN'],
  ['treasure-explorer','https://demo.bgaming-network.com/play/TreasureExplorer/FUN'],
];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const parse=s=>{try{return JSON.parse(s)}catch{return null}};
const service=new BrowserService(config);

async function one([label,url]){
  const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(s.id);
  try{
    await sleep(2500);
    const events=internal.recorder.eventsAfter(0);
    const hits=[];
    for(const ev of events){
      if(ev.type!=='responsebody'||!ev.body) continue;
      const body=parse(ev.body); if(!body) continue;
      if(!(body.jsonrpc||body.result||/\.demo\.bgaming-network\.com\/api/i.test(ev.url||''))) continue;
      const req=events.find(r=>r.type==='request'&&r.requestId===ev.requestId);
      hits.push({url:ev.url,request:req?{method:req.method,url:req.url,postData:req.postData,headers:req.headers}:null,body});
    }
    return {label,target:url,hits};
  }finally{await service.closeSession(s.id)}
}

await service.start();
try{
  const results=await Promise.all(targets.map(one));
  await fs.mkdir('artifacts/bg-jsonrpc',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc/results.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results.map(x=>({label:x.label,hits:x.hits.map(h=>({url:h.url,keys:Object.keys(h.body),request:h.request?.postData}))})),null,2));
}finally{await service.stop()}
