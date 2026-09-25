import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const service = new BrowserService(config);
await service.start();

async function printPlay(internal, marker, label) {
  await internal.recorder.waitForActivityAfter(marker, { timeoutMs: 5000 });
  await internal.recorder.waitForQuiet({ quietMs: 700, timeoutMs: 12000 });
  const events = internal.recorder.eventsAfter(marker);
  const rows=[];
  for (const req of events.filter(e=>e.type==='request' && (e.url||'').includes('gsc=play'))) {
    const res=events.find(e=>e.type==='response' && e.requestId===req.requestId);
    const body=events.find(e=>e.type==='responsebody' && e.requestId===req.requestId);
    rows.push({postData:req.postData,http:res?.status,body:body?.body?.slice(0,2500)||null});
  }
  console.log(label, JSON.stringify(rows,null,2));
  return rows;
}

async function coinup() {
  const session=await service.createSession({
    url:'https://3oaks.com/api/v1/games/coinup_volcano/play?lang=en',
    skipSplash:false,captureInitialScreenshot:false
  });
  const internal=service.sessions.get(session.id);
  try {
    await sleep(1200);
    await internal.page.evaluate(()=>window.TestActions?.closeStartScreen?.());
    await sleep(1000);
    const marker=internal.recorder.marker();
    await internal.page.evaluate(()=>window.TestActions?.openBuyFeaturePopup?.());
    await sleep(700);
    await internal.page.evaluate(()=>window.TestActions?.playBuyFeature?.(0));
    await sleep(900);
    await internal.page.evaluate(()=>window.TestActions?.playBuyFeature?.(0));
    const rows=await printPlay(internal,marker,'COINUP_DOUBLE_BUY');
    const shot=await service.capture(session.id,'coinup-double-buy');
    console.log('COINUP_SHOT',JSON.stringify(shot));
    return rows;
  } finally { await service.closeSession(session.id); }
}

async function superClover() {
  const session=await service.createSession({
    url:'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en',
    skipSplash:false,captureInitialScreenshot:false
  });
  const internal=service.sessions.get(session.id);
  try {
    await sleep(1500);
    const shape=await internal.page.evaluate(()=>{
      const raw=window.TestActions;
      return {
        type:typeof raw,
        source:typeof raw==='function'?Function.prototype.toString.call(raw).slice(0,3000):null,
        own:raw?Object.getOwnPropertyNames(raw):[],
        prototype:raw?.prototype?Object.getOwnPropertyNames(raw.prototype):[],
        windowCandidates:Object.keys(window).filter(k=>/test|action/i.test(k)).slice(0,100),
      };
    });
    console.log('SUPER_SHAPE',JSON.stringify(shape,null,2));
    const resolved=await internal.page.evaluate(()=>{
      const Raw=window.TestActions;
      if(typeof Raw!=='function') return {ok:false};
      const attempts=[
        ['app',()=>new Raw(window.app)],
        ['empty',()=>new Raw()],
      ];
      for(const [name,fn] of attempts){
        try{
          const v=fn();
          if(v){
            window.__playCiTA=v;
            return {ok:true,ctor:name,names:Object.getOwnPropertyNames(Object.getPrototypeOf(v))};
          }
        }catch(error){}
      }
      return {ok:false};
    });
    console.log('SUPER_RESOLVED',JSON.stringify(resolved,null,2));
    if(resolved.ok){
      const methods=await internal.page.evaluate(()=>{
        const ta=window.__playCiTA;
        const out={};
        for(const n of Object.getOwnPropertyNames(Object.getPrototypeOf(ta)).filter(x=>/buy|shop|spin|start|bonus|option/i.test(x))){
          if(typeof ta[n]==='function') out[n]=Function.prototype.toString.call(ta[n]).slice(0,3000);
        }
        return out;
      });
      console.log('SUPER_METHODS',JSON.stringify(methods,null,2));
    }
  } finally { await service.closeSession(session.id); }
}

try {
  try { await coinup(); } catch(error) { console.log('COINUP_ERROR',error?.stack||String(error)); }
  try { await superClover(); } catch(error) { console.log('SUPER_ERROR',error?.stack||String(error)); }
} finally { await service.stop(); }
