import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const cases=[
  {game:'GrandPatron7rst',terms:['round_mode_id','roundMode','rmid','SHOP3','SHOP2','ANTE','bet_slots','purchased_feature']},
  {game:'RocketEruptionTripleBlast',terms:['custom_req','buy_mode','normalBuyCost','superBuyCost','buy_bonus','purchased_feature','featureBuy']},
  {game:'TheGodfather3PillarsOfPower',terms:['custom_req','buy_mode','normalBuyCost','superBuyCost','buy_bonus','purchased_feature','featureBuy']},
  {game:'SweetSamurai',terms:['deep_spin','deep_bonanza','DEEP_SPIN','DEEP_BONANZA','purchased_feature','buy_bonus','custom_req','buy_mode']},
];

const service=new BrowserService({
  ...config,
  maxBodyBytes:20*1024*1024,
  maxMemoryEvents:50000,
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function snippets(body,term){
  const out=[];
  const low=body.toLowerCase(), needle=term.toLowerCase();
  let from=0;
  while(out.length<12){
    const i=low.indexOf(needle,from);
    if(i<0)break;
    out.push({index:i,text:body.slice(Math.max(0,i-1600),Math.min(body.length,i+2600))});
    from=i+needle.length;
  }
  return out;
}

await service.start();
try{
  const results=[];
  for(const c of cases){
    const url=`https://demo.bgaming-network.com/play/${c.game}/FUN?server=demo`;
    const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
    const internal=service.sessions.get(s.id);
    try{
      await sleep(11000);
      const events=internal.recorder.eventsAfter(0);
      const sources=[];
      for(const ev of events){
        if(ev.type!=='responsebody'||typeof ev.body!=='string'||ev.body.length<20)continue;
        const hits={};
        let count=0;
        for(const term of c.terms){
          const found=snippets(ev.body,term);
          if(found.length){hits[term]=found;count+=found.length;}
        }
        if(count)sources.push({url:ev.url,bytes:ev.body.length,hits});
      }
      results.push({game:c.game,url,sources});
    }catch(error){results.push({game:c.game,url,error:error.message,sources:[]});}
    finally{await service.closeSession(s.id).catch(()=>{});}
    await sleep(300);
  }
  await fs.mkdir('artifacts/bg-wire-gaps',{recursive:true});
  await fs.writeFile('artifacts/bg-wire-gaps/results.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results.map(r=>({game:r.game,error:r.error||null,sources:r.sources.map(s=>({url:s.url,bytes:s.bytes,terms:Object.fromEntries(Object.entries(s.hits).map(([k,v])=>[k,v.length]))}))})),null,2));
}finally{await service.stop();}
