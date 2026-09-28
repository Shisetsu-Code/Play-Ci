import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import {
  extractThreeOaksStart,
  summarizeThreeOaksStart,
  classifyThreeOaksPlay,
} from '../src/providers/three-oaks.js';

const targets = [
  { family:'hraymo', url:'https://3oaks.com/api/v1/games/3_african_drums/play?lang=en' },
  { family:'goreel', url:'https://3oaks.com/api/v1/games/3_aztec_temples/play?lang=en' },
  { family:'ratpack', url:'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en' },
  { family:'kendoo', url:'https://3oaks.com/api/v1/games/3_coin_volcanoes/play?lang=en' },
  { family:'enjoy', url:'https://3oaks.com/api/v1/games/3_superpower_diamonds/play?lang=en' },
  { family:'ratpack-legacy-2', url:'https://3oaks.com/api/v1/games/3_jewel_crowns/play?lang=en' },
  { family:'ratpack-legacy-4', url:'https://3oaks.com/api/v1/games/777_fruity_coins/play?lang=en' },
  { family:'goreel-fixed', url:'https://3oaks.com/api/v1/games/buddha_megaways/play?lang=en' },
];

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const service=new BrowserService(config);

async function dismiss(page){
  const method=await page.evaluate(()=>{
    try{
      const fn=window.TestActions?.closeStartScreen;
      if(typeof fn==='function'){
        const src=Function.prototype.toString.call(fn).replace(/\s+/g,'');
        if(!/\{\}$/.test(src)){fn.call(window.TestActions);return 'TestActions.closeStartScreen';}
      }
    }catch{}
    try{
      if(typeof window.app?.startScreen?.skip==='function'){
        window.app.startScreen.skip();
        return 'app.startScreen.skip';
      }
    }catch{}
    return null;
  }).catch(()=>null);
  if(!method) await page.mouse.click(config.viewport.width/2,config.viewport.height-50);
  await sleep(1800);
  return method||'viewport_click';
}

async function waitClient(page, timeout=12000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    const state=await page.evaluate(()=>({
      board:Boolean(window.app?.board),
      buyFeature:typeof window.app?.board?.buyFeature?.actBuyFeature==='function',
      buyBonus:typeof window.app?.board?.buyBonus?.actBuyFeature==='function',
      ui:Boolean(window.GR?.UI),
    })).catch(()=>null);
    if(state?.board&&(state.buyFeature||state.buyBonus||state.ui)) return state;
    await sleep(150);
  }
  return null;
}

async function prepare(page,family){
  return page.evaluate(async(family)=>{
    try{
      if(family==='ratpack'){
        const fn=window.TestActions?.openBuyFeaturePopup;
        if(typeof fn==='function'){
          const src=Function.prototype.toString.call(fn).replace(/\s+/g,'');
          if(!/\{\}$/.test(src)){
            fn.call(window.TestActions);
            await new Promise(r=>setTimeout(r,500));
            return {prepared:true,method:'TestActions.openBuyFeaturePopup'};
          }
        }
      }
      if(family==='kendoo'){
        const accessor=window.GR?.UI?.view?.buy_feature?.click;
        if(typeof accessor==='function'){
          const handler=accessor();
          if(typeof handler==='function'){
            handler();
            await new Promise(r=>setTimeout(r,500));
            return {prepared:true,method:'GR.UI.view.buy_feature.click handler'};
          }
        }
      }
    }catch(e){return {prepared:false,error:e.message}}
    return {prepared:false,method:'none'};
  },family);
}

async function invoke(page,mode){
  return page.evaluate((mode)=>{
    const owners=[
      ['app.board.buyFeature',window.app?.board?.buyFeature],
      ['app.board.buyBonus',window.app?.board?.buyBonus],
      ['app.buyBonus',window.app?.buyBonus],
    ];
    for(const [name,owner] of owners){
      const fn=owner?.actBuyFeature;
      if(typeof fn!=='function') continue;
      try{
        if(mode==null) fn.call(owner);
        else fn.call(owner,mode);
        return {ok:true,hook:name+'.actBuyFeature',argument:mode};
      }catch(e){}
    }
    try{
      if(typeof window.TestActions?.playBuyFeature==='function'){
        if(mode==null) window.TestActions.playBuyFeature();
        else window.TestActions.playBuyFeature(mode);
        return {ok:true,hook:'TestActions.playBuyFeature',argument:mode};
      }
    }catch(e){return {ok:false,error:e.message}}
    return {ok:false,error:'no_buy_hook'};
  },mode);
}

async function one(target){
  const session=await service.createSession({url:target.url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(session.id);
  try{
    const start=extractThreeOaksStart(internal.recorder.eventsAfter(0));
    if(!start)return {...target,ok:false,error:'start_missing'};
    const protocol=summarizeThreeOaksStart(start);
    const modes=protocol.available_buy_bonus||[];
    const fixed=Number.isFinite(Number(protocol.fixed_buy_multiplier))&&modes.length===0;
    if(!modes.length&&!fixed)return {...target,ok:false,error:'no_buy_modes',protocol};
    const mode=fixed?null:modes[0];

    if(!await waitClient(internal.page))return {...target,ok:false,error:'client_not_ready',mode,protocol};
    const dismissal=await dismiss(internal.page);
    const family=target.family.split('-')[0];
    const prep=await prepare(internal.page,family);
    const marker=internal.recorder.marker();
    const invocation=await invoke(internal.page,mode);

    await internal.recorder.waitForActivityAfter(marker,{timeoutMs:6000});
    await internal.recorder.waitForQuiet({quietMs:600,timeoutMs:9000});
    const play=classifyThreeOaksPlay(internal.recorder.eventsAfter(0),marker).at(-1)||null;
    const selected=play?.request?.action?.params?.selected_mode;
    const semantic=Boolean(
      play?.accepted &&
      play?.request?.action?.name==='buy_spin' &&
      (mode==null ? selected==null : String(selected)===String(mode))
    );
    return {
      ...target,mode,protocol:{modes:protocol.available_buy_bonus,prices:protocol.buy_bonus_prices,fixed:protocol.fixed_buy_multiplier,encoding:protocol.buy_mode_encoding},
      dismissal,prep,invocation,
      request:play?.request||null,
      http_status:play?.http_status??null,
      response_status:play?.response?.status??null,
      ok:semantic,
    };
  }finally{await service.closeSession(session.id);}
}

await service.start();
try{
  const results=[];
  for(const target of targets) results.push(await one(target));
  await fs.mkdir('artifacts/native-buy-test',{recursive:true});
  await fs.writeFile('artifacts/native-buy-test/results.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results,null,2));
  if(results.some(r=>!r.ok)) process.exitCode=1;
}finally{await service.stop();}
