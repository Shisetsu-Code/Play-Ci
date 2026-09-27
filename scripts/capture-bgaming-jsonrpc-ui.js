import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const games=['SugarMix','YommiRush','BlackbeardsBounty','ChickenFire'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const service=new BrowserService(config);

async function enter(page){
  await sleep(7000);
  for(const [x,y,wait] of [
    [640,650,900],
    [640,615,700],
    [640,570,700],
    [640,680,700],
    [1140,650,1400],
  ]){
    await page.mouse.click(x,y);
    await sleep(wait);
  }
  await sleep(2500);
}

async function frameSnapshot(frame){
  return frame.evaluate(()=>{
    const clean=(value,max=240)=>String(value||'').replace(/\s+/g,' ').trim().slice(0,max);
    const selector=[
      'button','a','input','[role="button"]','[tabindex]',
      '*[class*="button" i]','*[class*="btn" i]'
    ].join(',');
    const nodes=[...document.querySelectorAll(selector)];
    const controls=[];
    const seen=new Set();

    for(const el of nodes){
      const r=el.getBoundingClientRect();
      if(r.width<2||r.height<2) continue;
      const st=getComputedStyle(el);
      if(st.visibility==='hidden'||st.display==='none'||Number(st.opacity)===0) continue;
      const text=clean(el.textContent);
      const aria=clean(el.getAttribute('aria-label'));
      const title=clean(el.getAttribute('title'));
      const className=clean(el.className);
      const key=[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height),text,aria].join(':');
      if(seen.has(key)) continue;
      seen.add(key);
      controls.push({
        tag:el.tagName,
        text,
        aria,
        title,
        id:el.id||null,
        className,
        role:el.getAttribute('role'),
        cursor:st.cursor,
        rect:{x:r.x,y:r.y,width:r.width,height:r.height},
      });
      if(controls.length>=400) break;
    }

    return {
      url:location.href,
      title:document.title,
      bodyText:clean(document.body?.innerText,4000),
      controls,
      canvases:[...document.querySelectorAll('canvas')].map(c=>{
        const r=c.getBoundingClientRect();
        return {width:c.width,height:c.height,rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
      }),
      iframes:[...document.querySelectorAll('iframe')].map(f=>{
        const r=f.getBoundingClientRect();
        return {src:f.src,rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
      }),
    };
  }).catch(error=>({url:frame.url(),error:error.message}));
}

await service.start();
try{
  const results=[];
  for(const game of games){
    const url=`https://demo.bgaming-network.com/play/${game}/FUN`;
    const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
    const internal=service.sessions.get(s.id);
    const dir=path.join('artifacts','bg-jsonrpc-ui',game);
    await fs.mkdir(dir,{recursive:true});
    try{
      await enter(internal.page);
      const shot=await service.capture(s.id,'game');
      await fs.copyFile(path.resolve(shot.path),path.join(dir,'game.png'));

      const frames=[];
      for(const frame of internal.page.frames()){
        frames.push(await frameSnapshot(frame));
      }
      await fs.writeFile(path.join(dir,'frames.json'),JSON.stringify(frames,null,2),'utf8');
      results.push({game,url,ok:true,frames});
    }catch(error){
      results.push({game,url,ok:false,error:error.message});
    }finally{
      await service.closeSession(s.id);
      await sleep(300);
    }
  }

  await fs.writeFile('artifacts/bg-jsonrpc-ui/manifest.json',JSON.stringify(results,null,2),'utf8');
  const summary=results.map(result=>({
    game:result.game,
    ok:result.ok,
    frames:(result.frames||[]).map(frame=>({
      url:frame.url,
      bodyText:frame.bodyText,
      controls:(frame.controls||[]).filter(c=>
        /buy|bonus|chance|golden|spin|bet/i.test(
          [c.text,c.aria,c.title,c.id,c.className].filter(Boolean).join(' ')
        )
      ).slice(0,100),
      canvasCount:(frame.canvases||[]).length,
      iframeCount:(frame.iframes||[]).length,
      error:frame.error||null,
    })),
    error:result.error||null,
  }));
  console.log(JSON.stringify(summary,null,2));
}finally{
  await service.stop();
}
