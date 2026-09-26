import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const targets = [
  ['modern-map','https://demo.bgaming-network.com/play/ThreeLuckyMonkeysHoldAndWin/FUN?server=demo'],
  ['modern','https://demo.bgaming-network.com/play/AliceWonderLuck/FUN?server=demo'],
  ['legacy-extra','https://demo.bgaming-network.com/play/Avalon/FUN?server=demo'],
  ['legacy','https://demo.bgaming-network.com/play/BookOfCats/FUN?server=demo'],
  ['modern-recipes','https://demo.bgaming-network.com/play/CatsSoup/FUN?server=demo'],
];

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const service=new BrowserService(config);
const parse=s=>{try{return JSON.parse(s)}catch{return null}};

async function one([label,url]){
  const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(s.id);
  try{
    await sleep(1200);
    const events=internal.recorder.eventsAfter(0);
    const hits=[];
    for(const ev of events){
      if(ev.type!=='responsebody'||!ev.body||!/bgaming-network\.com\/api\//i.test(ev.url||''))continue;
      const body=parse(ev.body); if(!body)continue;
      const req=events.find(r=>r.type==='request'&&r.requestId===ev.requestId);
      hits.push({url:ev.url,request:req?{method:req.method,url:req.url,postData:req.postData,headers:req.headers}:null,body});
    }
    return {label,target:url,hits};
  }finally{await service.closeSession(s.id)}
}

await service.start();
try{
  const results=await Promise.all(targets.map(one));
  await fs.mkdir('artifacts/bg-bootstrap-fast',{recursive:true});
  await fs.writeFile('artifacts/bg-bootstrap-fast/bootstrap.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results.map(x=>({label:x.label,target:x.target,hits:x.hits.map(h=>({url:h.url,keys:Object.keys(h.body)}))})),null,2));
}finally{await service.stop()}
