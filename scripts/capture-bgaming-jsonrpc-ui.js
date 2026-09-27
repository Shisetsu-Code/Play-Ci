import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const games=[
  'JokerVsJoker',
  'JungleQueen',
  'KeepersOfTheSecret7rst',
  'RedHotChilliChickens',
  'DustyDuel',
];
const service=new BrowserService({...config,maxBodyBytes:18*1024*1024,maxMemoryEvents:40000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function safeName(url){
  const tail=url.split('/').pop()?.split('?')[0]||'asset';
  return tail.replace(/[^A-Za-z0-9._-]+/g,'_').slice(0,120);
}

function isUseful(url,body){
  if(typeof body!=='string'||body.length<80)return false;
  if(/\.(?:js|mjs)(?:\?|$)/i.test(url||''))return true;
  if(/\/api(?:\/|\?|$)/i.test(url||''))return true;
  if(/\.json(?:\?|$)/i.test(url||'') && /buy|bonus|feature|bet|wager|definition|config/i.test(body))return true;
  return false;
}

async function inspect(game){
  const variants=[
    `https://demo.bgaming-network.com/play/${game}/FUN?server=demo`,
    `https://demo.bgaming-network.com/play/${game}/FUN`,
  ];
  const attempts=[];
  for(const url of variants){
    const session=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
    const internal=service.sessions.get(session.id);
    const dir=path.join('artifacts','bg-jsonrpc-ui','sources',game,crypto.createHash('sha1').update(url).digest('hex').slice(0,8));
    await fs.mkdir(dir,{recursive:true});
    try{
      await sleep(9000);
      await internal.recorder.waitForQuiet({quietMs:500,timeoutMs:3000}).catch(()=>{});
      const events=internal.recorder.eventsAfter(0);
      const saved=[];
      for(const e of events){
        if(e.type!=='responsebody'||!isUseful(e.url,e.body))continue;
        const ext=/\.json(?:\?|$)/i.test(e.url||'')?'json':'txt';
        const name=`${String(saved.length).padStart(2,'0')}-${safeName(e.url)}-${crypto.createHash('sha1').update(e.url).digest('hex').slice(0,8)}.${ext}`;
        await fs.writeFile(path.join(dir,name),e.body,'utf8');
        saved.push({url:e.url,file:name,bytes:Buffer.byteLength(e.body)});
        if(saved.length>=18)break;
      }
      attempts.push({
        url,
        ok:true,
        final_url:internal.page.url(),
        title:await internal.page.title().catch(()=>null),
        saved,
      });
    }catch(error){
      attempts.push({url,ok:false,error:error.message,saved:[]});
    }finally{
      await service.closeSession(session.id).catch(()=>{});
      await sleep(300);
    }
  }
  return {game,attempts};
}

await service.start();
try{
  const results=[];
  for(const game of games)results.push(await inspect(game));
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results.map(r=>({
    game:r.game,
    attempts:r.attempts.map(a=>({
      url:a.url,ok:a.ok,final_url:a.final_url||null,title:a.title||null,
      saved:a.saved.map(s=>({url:s.url,file:s.file,bytes:s.bytes})),
      error:a.error||null,
    })),
  })),null,2));
}finally{await service.stop()}
