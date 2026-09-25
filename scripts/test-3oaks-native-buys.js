import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractThreeOaksStart, classifyThreeOaksPlay } from '../src/providers/three-oaks.js';

const targets = [
  { family:'hraymo', url:'https://3oaks.com/api/v1/games/3_african_drums/play?lang=en' },
  { family:'goreel', url:'https://3oaks.com/api/v1/games/3_aztec_temples/play?lang=en' },
  { family:'ratpack', url:'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en' },
  { family:'kendoo', url:'https://3oaks.com/api/v1/games/3_coin_volcanoes/play?lang=en' },
  { family:'enjoy', url:'https://3oaks.com/api/v1/games/3_superpower_diamonds/play?lang=en' },
];

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const service=new BrowserService(config);

async function waitBoard(page, timeout=15000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    const state=await page.evaluate(()=>({
      board:Boolean(window.app?.board),
      buy:typeof window.app?.board?.buyFeature?.actBuyFeature==='function',
      ta:Boolean(window.TestActions)
    })).catch(()=>null);
    if(state?.buy) return state;
    await sleep(150);
  }
  return null;
}

async function dismiss(page){
  const result=await page.evaluate(()=>{
    try {
      const fn=window.TestActions?.closeStartScreen;
      if(typeof fn==='function'){
        const s=Function.prototype.toString.call(fn).replace(/\s+/g,'');
        if(!/\{\}$/.test(s)){ fn.call(window.TestActions); return 'TestActions.closeStartScreen'; }
      }
    }catch{}
    try {
      if(typeof window.app?.startScreen?.skip==='function'){window.app.startScreen.skip();return 'app.startScreen.skip';}
    }catch{}
    return null;
  });
  if(!result) await page.mouse.click(config.viewport.width/2,config.viewport.height-50);
  await sleep(1200);
  return result||'viewport_click';
}

async function one(target){
  const session=await service.createSession({url:target.url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  try{
    const initial=extractThreeOaksStart(internal.recorder.eventsAfter(0));
    if(!initial) return {...target,ok:false,error:'start_missing'};
    const modes=initial.body?.context?.available_buy_bonus||[];
    if(!modes.length) return {...target,ok:false,error:'no_buy_modes'};
    const mode=modes[0];

    const ready=await waitBoard(internal.page);
    if(!ready) return {...target,ok:false,error:'buy_feature_not_ready',mode};
    const dismissal=await dismiss(internal.page);
    const marker=internal.recorder.marker();

    const invocation=await internal.page.evaluate((m)=>{
      const fn=window.app?.board?.buyFeature?.actBuyFeature;
      if(typeof fn!=='function') return {ok:false,error:'missing'};
      try { fn.call(window.app.board.buyFeature,m); return {ok:true}; }
      catch(e){return {ok:false,error:e.message};}
    },mode);

    await internal.recorder.waitForActivityAfter(marker,{timeoutMs:5000});
    await internal.recorder.waitForQuiet({quietMs:600,timeoutMs:8000});
    const plays=classifyThreeOaksPlay(internal.recorder.eventsAfter(0),marker);
    const play=plays.at(-1)||null;
    return {
      ...target,mode,dismissal,invocation,
      request:play?.request||null,
      http_status:play?.http_status??null,
      response_status:play?.response?.status??null,
      last_action:play?.response?.context?.last_action??null,
      ok:Boolean(play?.accepted && Number(play?.request?.action?.params?.selected_mode)===Number(mode)),
    };
  }finally{await service.closeSession(session.id);}
}

await service.start();
try{
  const results=[];
  for(const t of targets) results.push(await one(t));
  await fs.mkdir('artifacts/native-buy-test',{recursive:true});
  await fs.writeFile('artifacts/native-buy-test/results.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results,null,2));
  if(results.some(r=>!r.ok)) process.exitCode=1;
}finally{await service.stop();}
