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
      spin:typeof window.TestActions?.spin==='function'||typeof window.app?.board?.spin==='function'
    })).catch(()=>null);
    if(state?.shop&&state?.spin) return state;
    await sleep(150);
  }
  return null;
}
async function dismiss(page){
  await page.evaluate(()=>{
    try{if(typeof window.TestActions?.closeStartScreen==='function'){window.TestActions.closeStartScreen();return;}}catch{}
    try{window.app?.startScreen?.skip?.();}catch{}
  }).catch(()=>{});
  await sleep(1200);
}
async function one(t){
  const session=await service.createSession({url:t.url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  try{
    const start=extractThreeOaksStart(internal.recorder.eventsAfter(0));
    const modes=start?.body?.context?.available_booster||[];
    const prices=start?.body?.settings?.booster_prices||{};
    if(!modes.length)return {...t,ok:false,error:'no_boosters'};
    const mode=modes[0], expected=Number(prices[String(mode)]);
    if(!await waitReady(internal.page))return {...t,ok:false,error:'not_ready',mode,expected};
    await dismiss(internal.page);
    const marker=internal.recorder.marker();
    const inv=await internal.page.evaluate((m)=>{
      try{
        const shop=window.app?.board?.bonusShopPopup;
        if(typeof shop?.activateShopOption!=='function')return {ok:false,error:'shop_missing'};
        shop.activateShopOption(m);
        const ta=window.TestActions;
        if(typeof ta?.spin==='function'){ta.spin();return {ok:true,spin:'TestActions.spin'};}
        if(typeof window.app?.board?.spin==='function'){window.app.board.spin();return {ok:true,spin:'app.board.spin'};}
        return {ok:false,error:'spin_missing'};
      }catch(e){return {ok:false,error:e.message};}
    },mode);
    await internal.recorder.waitForActivityAfter(marker,{timeoutMs:5000});
    await internal.recorder.waitForQuiet({quietMs:600,timeoutMs:8000});
    const plays=classifyThreeOaksPlay(internal.recorder.eventsAfter(0),marker);
    const play=plays.at(-1)||null;
    const params=play?.request?.action?.params||{};
    return {
      ...t,mode,expected,inv,
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
