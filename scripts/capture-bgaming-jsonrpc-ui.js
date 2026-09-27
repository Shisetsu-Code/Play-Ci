import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const game='AllLuckyClover';
const url='https://demo.bgaming-network.com/play/AllLuckyClover/FUN?server=demo';
const service=new BrowserService({...config,maxBodyBytes:12*1024*1024,maxMemoryEvents:30000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function snippets(body){
  if(typeof body!=='string')return [];
  const terms=['line_bets','available_bets','default_bet','bet_per_line','paylines','linesCount','lineCount','betLevels','bet_values','bets','totalBet'];
  const out=[];
  const lower=body.toLowerCase();
  for(const term of terms){
    let from=0;
    const needle=term.toLowerCase();
    while(out.length<80){
      const at=lower.indexOf(needle,from);
      if(at<0)break;
      out.push({term,snippet:body.slice(Math.max(0,at-500),Math.min(body.length,at+needle.length+1000)).replace(/\s+/g,' ')});
      from=at+needle.length;
    }
  }
  return out;
}

await service.start();
try{
  const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  const dir=path.join('artifacts','bg-jsonrpc-ui',game);
  await fs.mkdir(dir,{recursive:true});
  const report={game,url,ok:false};
  try{
    await sleep(6500);
    let shot=await service.capture(session.id,'ready');
    await fs.copyFile(path.resolve(shot.path),path.join(dir,'00-ready.png'));

    for(const [x,y,wait] of [[640,570,1200],[640,650,1000],[640,680,1000]]){
      await internal.page.mouse.click(x,y).catch(()=>{});
      await sleep(wait);
    }
    await sleep(1800);
    shot=await service.capture(session.id,'game');
    await fs.copyFile(path.resolve(shot.path),path.join(dir,'01-game.png'));

    const events=internal.recorder.eventsAfter(0);
    const sources=[];
    for(const e of events){
      if(e.type!=='responsebody'||typeof e.body!=='string')continue;
      const hits=snippets(e.body);
      if(hits.length)sources.push({url:e.url,bytes:Buffer.byteLength(e.body),hits:hits.slice(0,40)});
    }

    report.ok=true;
    report.final_url=internal.page.url();
    report.sources=sources.slice(0,40);
    report.requests=events.filter(e=>e.type==='request'&&/bgaming-network\.com\/api\//i.test(e.url||'')).map(e=>({
      url:e.url,method:e.method,postData:e.postData,
    }));
    await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2),'utf8');
  }catch(error){
    report.error=error.message;
  }finally{
    await service.closeSession(session.id).catch(()=>{});
  }
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(report,null,2),'utf8');
  console.log(JSON.stringify({
    game:report.game,ok:report.ok,final_url:report.final_url||null,
    requests:report.requests||[],
    sources:(report.sources||[]).map(s=>({url:s.url,hits:s.hits.map(h=>h.term)})),
    error:report.error||null,
  },null,2));
}finally{
  await service.stop();
}
