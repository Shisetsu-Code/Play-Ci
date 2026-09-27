import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const games=['AllLuckyClover','PrincessOfSky','PrincessRoyal','ScrollOfAdventure'];
const variants=[
  game=>`https://demo.bgaming-network.com/play/${game}/FUN?server=demo`,
  game=>`https://bgaming-network.com/play/${game}/FUN?server=demo`,
  game=>`https://demo.bgaming-network.com/play/${game}/FUN?server=demo_fun_curacao`,
];

const service=new BrowserService({...config,maxBodyBytes:4*1024*1024,maxMemoryEvents:20000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const parse=s=>{try{return JSON.parse(s)}catch{return null}};

function compact(events){
  const out=[];
  for(const e of events){
    if(!['request','response','responsebody','requestfailed'].includes(e.type))continue;
    const url=e.url||'';
    if(!/bgaming-network\.com|bgaming-system\.com/i.test(url))continue;
    let body=e.body;
    if(typeof body==='string'&&body.length>12000)body=body.slice(0,12000);
    out.push({
      seq:e.seq,type:e.type,requestId:e.requestId,url,method:e.method,status:e.status,
      postData:e.postData,body,errorText:e.errorText,
    });
  }
  return out.slice(-500);
}

async function inspect(game,url){
  const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  try{
    await sleep(8500);
    const before=internal.recorder.marker();
    for(const [x,y,wait] of [[640,650,800],[640,570,800],[640,360,800],[1125,680,1600]]){
      await internal.page.mouse.click(x,y).catch(()=>{});
      await sleep(wait);
    }
    await internal.recorder.waitForQuiet({quietMs:500,timeoutMs:2500}).catch(()=>{});
    const events=internal.recorder.eventsAfter(0);
    const jsonResponses=[];
    for(const e of events){
      if(e.type!=='responsebody'||typeof e.body!=='string')continue;
      const parsed=parse(e.body);
      if(!parsed)continue;
      const req=events.find(r=>r.type==='request'&&r.requestId===e.requestId);
      const reqBody=parse(req?.postData||'');
      if(
        /bgaming-network\.com\/api\//i.test(e.url||'') ||
        reqBody?.command==='init' ||
        parsed?.wallet!=null ||
        parsed?.game!=null ||
        parsed?.options!=null ||
        parsed?.api_version!=null ||
        parsed?.jsonrpc==='2.0'
      ){
        jsonResponses.push({
          url:e.url,
          request:req?{method:req.method,url:req.url,postData:req.postData}:null,
          body:parsed,
        });
      }
    }
    return {
      game,url,ok:true,final_url:internal.page.url(),
      title:await internal.page.title().catch(()=>null),
      text:await internal.page.locator('body').innerText().catch(()=>null),
      jsonResponses,
      post_click_events:compact(events.filter(e=>e.seq>before)),
      failed:events.filter(e=>e.type==='requestfailed').map(e=>({url:e.url,errorText:e.errorText})).slice(-80),
    };
  }catch(error){
    return {game,url,ok:false,error:error.message};
  }finally{
    await service.closeSession(session.id).catch(()=>{});
  }
}

await service.start();
try{
  const results=[];
  for(const game of games){
    for(const makeUrl of variants){
      results.push(await inspect(game,makeUrl(game)));
      await sleep(300);
    }
  }
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/unknown-bgaming.json',JSON.stringify(results,null,2),'utf8');
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(results.map(r=>({
    game:r.game,url:r.url,ok:r.ok,final_url:r.final_url||null,title:r.title||null,
    json:r.jsonResponses?.map(x=>({url:x.url,keys:Object.keys(x.body||{}),request:x.request}))||[],
    failures:r.failed?.slice(0,12)||[],error:r.error||null,
  })),null,2),'utf8');
  console.log(JSON.stringify(results.map(r=>({
    game:r.game,url:r.url,ok:r.ok,final_url:r.final_url||null,title:r.title||null,
    json:r.jsonResponses?.map(x=>({url:x.url,keys:Object.keys(x.body||{}),request:x.request}))||[],
    failures:r.failed?.slice(0,12)||[],error:r.error||null,
  })),null,2));
}finally{
  await service.stop();
}
