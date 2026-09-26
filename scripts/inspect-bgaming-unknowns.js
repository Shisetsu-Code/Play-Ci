import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const games=['AllLuckyClover','BlackbeardsBounty','DustyDuel','PrincessOfSky','PrincessRoyal','ScrollOfAdventure'];
const service=new BrowserService(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const parse=s=>{try{return JSON.parse(s)}catch{return null}};

async function inspect(game){
  const urls=[
    'https://demo.bgaming-network.com/play/'+game+'/FUN?server=demo',
    'https://bgaming-network.com/play/'+game+'/FUN?server=demo',
  ];
  const attempts=[];
  for(const url of urls){
    const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
    const internal=service.sessions.get(s.id);
    try{
      await sleep(10000);
      const events=internal.recorder.eventsAfter(0);
      const api=[];
      const rpc=[];
      for(const ev of events){
        if(ev.type!=='responsebody'||!ev.body)continue;
        const body=parse(ev.body); if(!body)continue;
        const req=events.find(r=>r.type==='request'&&r.requestId===ev.requestId);
        if(/bgaming-network\.com\/api\//i.test(ev.url||'') || body.options || body.game || body.flow){
          api.push({url:ev.url,request:req?{method:req.method,url:req.url,postData:req.postData,headers:req.headers}:null,body});
        }
        if(body.jsonrpc==='2.0'||body.result?.config){
          rpc.push({url:ev.url,request:req?{method:req.method,url:req.url,postData:req.postData,headers:req.headers}:null,body});
        }
      }
      attempts.push({url,final_url:internal.page.url(),api,rpc,all_json:events.filter(e=>e.type==='responsebody'&&parse(e.body)).length});
    }catch(error){attempts.push({url,error:error.message});}
    finally{await service.closeSession(s.id)}
  }
  return {game,attempts};
}

await service.start();
try{
  const results=[];
  for(const game of games)results.push(await inspect(game));
  await fs.mkdir('artifacts/bg-unknowns',{recursive:true});
  await fs.writeFile('artifacts/bg-unknowns/results.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results.map(x=>({game:x.game,attempts:x.attempts.map(a=>({url:a.url,final_url:a.final_url,api:a.api?.map(h=>({url:h.url,keys:Object.keys(h.body)})),rpc:a.rpc?.map(h=>({url:h.url,keys:Object.keys(h.body)})),error:a.error}))})),null,2));
}finally{await service.stop()}
