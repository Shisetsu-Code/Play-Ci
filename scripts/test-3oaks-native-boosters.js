import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractThreeOaksStart, classifyThreeOaksPlay } from '../src/providers/three-oaks.js';

const targets=[
  {family:'goreel',url:'https://3oaks.com/api/v1/games/dj_tiger_x1000/play?lang=en'},
  {family:'ratpack',url:'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en'},
];
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const service=new BrowserService(config);

async function waitReady(page,timeout=15000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    const state=await page.evaluate(()=>({
      shop:typeof window.app?.board?.bonusShopPopup?.activateShopOption==='function',
      hasEvents:Boolean(window.GR?.UI?.Events),
      hasBoard:Boolean(window.app?.board)
    })).catch(()=>null);
    if(state?.shop&&state?.hasEvents)return state;
    await sleep(150);
  }
  return null;
}

async function dismiss(page){
  await page.evaluate(()=>{
    try{if(typeof window.TestActions?.closeStartScreen==='function'){window.TestActions.closeStartScreen();return;}}catch{}
    try{window.app?.startScreen?.skip?.();}catch{}
  }).catch(()=>{});
  await sleep(1400);
}

async function describeSpin(page){
  return page.evaluate(()=>{
    const src=(fn)=>{try{return Function.prototype.toString.call(fn).slice(0,1200)}catch{return null}};
    const out={events:{},board:{},test:{}};
    const events=window.GR?.UI?.Events;
    if(events){
      for(const k of Object.getOwnPropertyNames(events)){
        let v;try{v=events[k]}catch{continue;}
        if(typeof v==='function'&&/spin|play|action|start/i.test(k))out.events[k]=src(v);
      }
    }
    const board=window.app?.board;
    if(board){
      const keys=[...new Set([...Object.getOwnPropertyNames(board),...Object.getOwnPropertyNames(Object.getPrototypeOf(board)||{})])];
      for(const k of keys){
        let v;try{v=board[k]}catch{continue;}
        if(typeof v==='function'&&/spin|play|action|start/i.test(k))out.board[k]=src(v);
      }
    }
    const ta=window.TestActions;
    if(ta){
      const keys=[...new Set([...Object.getOwnPropertyNames(ta),...Object.getOwnPropertyNames(Object.getPrototypeOf(ta)||{})])];
      for(const k of keys){
        let v;try{v=ta[k]}catch{continue;}
        if(typeof v==='function'&&/spin|play|action|start/i.test(k))out.test[k]=src(v);
      }
    }
    return out;
  });
}

async function triggerSpin(page){
  return page.evaluate(async()=>{
    const attempts=[];
    const run=async(name,fn)=>{
      if(typeof fn!=='function')return null;
      try{
        const result=fn();
        if(result?.then)await Promise.race([result,new Promise(r=>setTimeout(r,500))]);
        return {ok:true,name};
      }catch(e){attempts.push({name,error:e.message});return null;}
    };
    let r;
    r=await run('GR.UI.Events.spin',window.GR?.UI?.Events?.spin);
    if(r)return r;
    r=await run('GR.UI.Events.spin_click',window.GR?.UI?.Events?.spin_click);
    if(r)return r;
    r=await run('GR.UI.Events.play',window.GR?.UI?.Events?.play);
    if(r)return r;
    r=await run('app.board.spin',window.app?.board?.spin?.bind(window.app.board));
    if(r)return r;
    r=await run('TestActions.spin',window.TestActions?.spin?.bind(window.TestActions));
    if(r)return r;
    return {ok:false,attempts};
  });
}

async function one(t){
  const session=await service.createSession({url:t.url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  try{
    const start=extractThreeOaksStart(internal.recorder.eventsAfter(0));
    const modes=start?.body?.context?.available_booster||[];
    const prices=start?.body?.settings?.booster_prices||{};
    if(!modes.length)return {...t,ok:false,error:'no_boosters'};
    const mode=modes[0],expected=Number(prices[String(mode)]);
    if(!await waitReady(internal.page))return {...t,ok:false,error:'not_ready',mode,expected};
    await dismiss(internal.page);
    const spinShape=await describeSpin(internal.page);

    const marker=internal.recorder.marker();
    const select=await internal.page.evaluate((m)=>{
      try{
        const popup=window.app?.board?.bonusShopPopup;
        if(typeof popup?.activateShopOption!=='function')return {ok:false,error:'shop_missing'};
        popup.activateShopOption(m);
        return {
          ok:true,
          booster_option:window.GR?.UI?.model?.get?.('booster_option')??null
        };
      }catch(e){return {ok:false,error:e.message};}
    },mode);
    await sleep(200);
    const spin=await triggerSpin(internal.page);

    await internal.recorder.waitForActivityAfter(marker,{timeoutMs:6000});
    await internal.recorder.waitForQuiet({quietMs:600,timeoutMs:9000});
    const plays=classifyThreeOaksPlay(internal.recorder.eventsAfter(0),marker);
    const play=plays.at(-1)||null;
    const params=play?.request?.action?.params||{};
    return {
      ...t,mode,expected,select,spin,spinShape,
      request:play?.request||null,
      http_status:play?.http_status??null,
      response_status:play?.response?.status??null,
      ok:Boolean(play?.accepted &&
        Number(params.selected_mode)===Number(mode) &&
        Number(params.ante_bet)===Number(expected))
    };
  }finally{await service.closeSession(session.id);}
}

await service.start();
try{
  const results=[];
  for(const t of targets)results.push(await one(t));
  await fs.mkdir('artifacts/native-booster-test',{recursive:true});
  await fs.writeFile('artifacts/native-booster-test/results.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results,null,2));
  if(results.some(r=>!r.ok))process.exitCode=1;
}finally{await service.stop();}
