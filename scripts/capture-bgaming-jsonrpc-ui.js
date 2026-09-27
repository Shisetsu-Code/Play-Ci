import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const url='https://demo.bgaming-network.com/play/AllLuckyClover/FUN?server=demo';
const service=new BrowserService({...config,maxBodyBytes:14*1024*1024,maxMemoryEvents:25000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function numericArrays(text){
  const rows=[];
  const re=/\[((?:\s*-?\d+(?:\.\d+)?\s*,){2,40}\s*-?\d+(?:\.\d+)?\s*)\]/g;
  for(const m of text.matchAll(re)){
    const vals=m[1].split(',').map(Number);
    if(vals.every(Number.isFinite))rows.push({at:m.index,values:vals});
    if(rows.length>2000)break;
  }
  return rows;
}

function windows(body){
  const terms=['line_bets','available_bets','default_bet','AllLuckyClover5','AllLuckyClover20','AllLuckyClover40','AllLuckyClover100'];
  const arrays=numericArrays(body);
  const out=[];
  const lower=body.toLowerCase();
  for(const term of terms){
    let from=0;
    while(out.length<120){
      const at=lower.indexOf(term.toLowerCase(),from);
      if(at<0)break;
      const nearby=arrays.filter(a=>Math.abs(a.at-at)<5000).slice(0,30);
      out.push({
        term,
        at,
        arrays:nearby,
        snippet:body.slice(Math.max(0,at-2600),Math.min(body.length,at+term.length+4200)).replace(/\s+/g,' '),
      });
      from=at+term.length;
    }
  }
  return out;
}

await service.start();
try{
  const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  const report={ok:false};
  try{
    await sleep(7000);
    const events=internal.recorder.eventsAfter(0);
    const sources=[];
    for(const e of events){
      if(e.type!=='responsebody'||typeof e.body!=='string')continue;
      if(!/AllLuckyClover.*bundle\.js/i.test(e.url||''))continue;
      sources.push({url:e.url,bytes:Buffer.byteLength(e.body),windows:windows(e.body)});
    }
    report.ok=true;
    report.sources=sources;
  }catch(error){report.error=error.message}
  finally{await service.closeSession(session.id).catch(()=>{})}

  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/all-lucky-static.json',JSON.stringify(report,null,2),'utf8');
  console.log(JSON.stringify({
    ok:report.ok,
    sources:(report.sources||[]).map(s=>({
      url:s.url,
      windows:s.windows.map(w=>({term:w.term,arrays:w.arrays.map(a=>a.values),snippet:w.snippet.slice(0,1800)})),
    })),
    error:report.error||null,
  },null,2));
}finally{await service.stop()}
