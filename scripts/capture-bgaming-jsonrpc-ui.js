import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractBgamingJsonRpcInit } from '../src/providers/bgaming.js';

const GAMES=[
  'GrandPatron7rst',
  'RocketEruptionTripleBlast',
  'TheGodfather3PillarsOfPower',
  'SweetSamurai',
];

const service=new BrowserService({
  ...config,
  maxBodyBytes:20*1024*1024,
  maxMemoryEvents:50000,
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const ECONOMIC=/buy|bonus|ante|shop|feature|freespin|free\s*spin|respin|deep|super/i;
const SAFE_START=/^(play|start|continue|skip|enter|close|ok|got it|accept|understood)$/i;

async function frameSnapshot(frame){
  return frame.evaluate(({economicSource})=>{
    const economic=new RegExp(economicSource,'i');
    const visible=(el)=>{
      const r=el.getBoundingClientRect();
      const s=getComputedStyle(el);
      return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0;
    };
    const rect=(el)=>{
      const r=el.getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height};
    };
    const textOf=(el)=>[
      el.innerText,
      el.textContent,
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('title'),
      el.getAttribute?.('data-testid'),
      el.getAttribute?.('name'),
      el.id,
      el.className,
    ].filter(v=>typeof v==='string'&&v.trim()).join(' ').replace(/\s+/g,' ').trim().slice(0,500);

    const clickable=[...document.querySelectorAll(
      'button,[role="button"],a,input,[onclick],[tabindex],*[style*="cursor: pointer"],*[style*="cursor:pointer"]'
    )]
      .filter(visible)
      .map((el,index)=>({
        index,
        tag:el.tagName,
        text:textOf(el),
        rect:rect(el),
        disabled:Boolean(el.disabled),
      }))
      .filter(x=>x.text||x.tag==='BUTTON')
      .slice(0,250);

    const canvases=[...document.querySelectorAll('canvas')]
      .filter(visible)
      .map((c,index)=>({
        index,width:c.width,height:c.height,rect:rect(c),
        id:c.id||null,className:typeof c.className==='string'?c.className:null,
      }));

    const economicElements=[...document.querySelectorAll('*')]
      .filter(visible)
      .map((el,index)=>({index,tag:el.tagName,text:textOf(el),rect:rect(el)}))
      .filter(x=>x.text&&economic.test(x.text))
      .slice(0,180);

    const globals={
      hasPIXI:Boolean(window.PIXI),
      hasCocos:Boolean(window.cc),
      hasPhaser:Boolean(window.Phaser),
      candidates:Object.keys(window)
        .filter(k=>/pixi|cocos|phaser|game|app|scene|slot|bonus|buy/i.test(k))
        .slice(0,160),
    };

    let cocos=[];
    try{
      const root=window.cc?.director?.getRunningScene?.();
      if(root){
        const stack=[{node:root,path:'scene',depth:0}];
        let seen=0;
        while(stack.length&&seen<5000){
          const {node,path,depth}=stack.shift();
          seen++;
          const name=String(node?.name||node?._name||'');
          const ctor=String(node?.constructor?.name||'');
          const hay=(name+' '+ctor).trim();
          if(economic.test(hay)){
            let box=null;
            try{
              const b=node.getBoundingBoxToWorld?.()||node.getBoundingBox?.();
              if(b)box={x:b.x,y:b.y,width:b.width,height:b.height};
            }catch{}
            cocos.push({
              path,name,ctor,visible:node.visible??node.active??null,
              x:node.x??node._position?.x??null,
              y:node.y??node._position?.y??null,
              width:node.width??node._contentSize?.width??null,
              height:node.height??node._contentSize?.height??null,
              box,
            });
            if(cocos.length>=160)break;
          }
          if(depth<12){
            const children=node?.children||node?._children||[];
            if(Array.isArray(children)){
              for(let i=0;i<Math.min(children.length,500);i++){
                stack.push({node:children[i],path:path+'/'+(children[i]?.name||children[i]?._name||i),depth:depth+1});
              }
            }
          }
        }
      }
    }catch{}

    return {
      url:location.href,
      title:document.title,
      bodyText:(document.body?.innerText||'').replace(/\s+/g,' ').trim().slice(0,4000),
      clickable,
      canvases,
      economicElements,
      globals,
      cocos,
    };
  },{economicSource:ECONOMIC.source}).catch(error=>({url:frame.url(),error:error.message}));
}

async function allFrames(page){
  const out=[];
  for(const [index,frame] of page.frames().entries()){
    out.push({index,...await frameSnapshot(frame)});
  }
  return out;
}

async function dismissSafeDomStartup(page){
  const actions=[];
  for(const [frameIndex,frame] of page.frames().entries()){
    const candidates=await frame.locator(
      'button,[role="button"],a,input[type="button"],input[type="submit"],[onclick]'
    ).evaluateAll((els)=>els.map((el,index)=>{
      const r=el.getBoundingClientRect();
      const s=getComputedStyle(el);
      const text=[
        el.innerText,el.textContent,el.getAttribute('aria-label'),
        el.getAttribute('title'),el.value
      ].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
      return {
        index,text,
        visible:r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden',
      };
    })).catch(()=>[]);

    const safe=candidates.filter(x=>
      x.visible &&
      SAFE_START.test(x.text) &&
      !ECONOMIC.test(x.text)
    );
    if(safe.length!==1)continue;

    const locator=frame.locator(
      'button,[role="button"],a,input[type="button"],input[type="submit"],[onclick]'
    ).nth(safe[0].index);
    try{
      await locator.click({timeout:1500});
      actions.push({frameIndex,text:safe[0].text});
      await sleep(1200);
    }catch{}
  }
  return actions;
}

function playRequests(events,afterSeq=0){
  return events
    .filter(e=>e.seq>afterSeq&&e.type==='request'&&typeof e.postData==='string')
    .map(e=>{
      let body=null;
      try{body=JSON.parse(e.postData)}catch{}
      return {seq:e.seq,url:e.url,method:e.method,postData:e.postData,body};
    })
    .filter(e=>
      e.body?.method==='play' ||
      e.body?.command==='spin' ||
      e.body?.command==='buy' ||
      ECONOMIC.test(e.postData)
    );
}

async function inspect(game){
  const url=`https://demo.bgaming-network.com/play/${game}/FUN?server=demo`;
  const session=await service.createSession({
    url,skipSplash:false,captureInitialScreenshot:false,
  });
  const internal=service.sessions.get(session.id);
  const dir=path.join('artifacts','bg-jsonrpc-ui',game);
  await fs.mkdir(dir,{recursive:true});

  try{
    await sleep(8500);
    await internal.recorder.waitForQuiet({quietMs:500,timeoutMs:2500}).catch(()=>{});

    const ready=await service.capture(session.id,'00-ready');
    await fs.copyFile(path.resolve(ready.path),path.join(dir,'00-ready.png'));

    const beforeFrames=await allFrames(internal.page);
    await fs.writeFile(path.join(dir,'00-frames.json'),JSON.stringify(beforeFrames,null,2),'utf8');

    const marker=internal.recorder.marker();
    const safeActions=await dismissSafeDomStartup(internal.page);
    if(safeActions.length)await sleep(1800);

    const settled=await service.capture(session.id,'01-settled');
    await fs.copyFile(path.resolve(settled.path),path.join(dir,'01-settled.png'));

    const afterFrames=await allFrames(internal.page);
    await fs.writeFile(path.join(dir,'01-frames.json'),JSON.stringify(afterFrames,null,2),'utf8');

    const events=internal.recorder.eventsAfter(0);
    const init=extractBgamingJsonRpcInit(events);

    const report={
      game,url,ok:true,
      final_url:internal.page.url(),
      init:{
        endpoint:init?.request?.url||null,
        bet_limits:init?.body?.result?.config?.bet_limits||[],
        purchased_features:init?.body?.result?.config?.purchased_features||[],
      },
      safe_start_actions:safeActions,
      startup_play_requests:playRequests(events,marker),
      frame_count:afterFrames.length,
      economic_dom_candidates:afterFrames.flatMap(f=>
        (f.economicElements||[]).map(x=>({frameIndex:f.index,frameUrl:f.url,...x}))
      ).slice(0,250),
      clickable_candidates:afterFrames.flatMap(f=>
        (f.clickable||[]).filter(x=>ECONOMIC.test(x.text||'')).map(x=>({frameIndex:f.index,frameUrl:f.url,...x}))
      ).slice(0,250),
      cocos_candidates:afterFrames.flatMap(f=>
        (f.cocos||[]).map(x=>({frameIndex:f.index,frameUrl:f.url,...x}))
      ).slice(0,250),
      canvas_frames:afterFrames.filter(f=>(f.canvases||[]).length).map(f=>({
        frameIndex:f.index,frameUrl:f.url,canvases:f.canvases,
      })),
    };
    await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2),'utf8');
    return report;
  }catch(error){
    return {game,url,ok:false,error:error.message};
  }finally{
    await service.closeSession(session.id).catch(()=>{});
  }
}

await service.start();
try{
  const results=[];
  for(const game of GAMES){
    results.push(await inspect(game));
    await sleep(400);
  }
  await fs.mkdir('artifacts/bg-jsonrpc-ui',{recursive:true});
  await fs.writeFile(
    'artifacts/bg-jsonrpc-ui/manifest.json',
    JSON.stringify(results.map(r=>({
      game:r.game,ok:r.ok,final_url:r.final_url||null,
      safe_start_actions:r.safe_start_actions||[],
      economic_dom_candidates:(r.economic_dom_candidates||[]).length,
      clickable_candidates:(r.clickable_candidates||[]).length,
      cocos_candidates:(r.cocos_candidates||[]).length,
      canvas_frames:(r.canvas_frames||[]).length,
      error:r.error||null,
    })),null,2),
    'utf8'
  );
  console.log(JSON.stringify(results.map(r=>({
    game:r.game,ok:r.ok,final_url:r.final_url||null,
    safe_start_actions:r.safe_start_actions||[],
    economic_dom_candidates:(r.economic_dom_candidates||[]).length,
    clickable_candidates:(r.clickable_candidates||[]).length,
    cocos_candidates:(r.cocos_candidates||[]).length,
    canvas_frames:(r.canvas_frames||[]).length,
    error:r.error||null,
  })),null,2));
}finally{
  await service.stop();
}
