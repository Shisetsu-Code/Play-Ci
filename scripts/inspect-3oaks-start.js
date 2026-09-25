import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const service=new BrowserService(config);
await service.start();

try{
  const session=await service.createSession({
    url:'https://3oaks.com/api/v1/games/coinup_volcano/play?lang=en',
    skipSplash:false,
    captureInitialScreenshot:false,
  });
  const internal=service.sessions.get(session.id);

  await sleep(10000);
  console.log('PRE_READY',JSON.stringify(await service.capture(session.id,'pre-ready')));

  const state=await internal.page.evaluate(()=>{
    const ta=window.TestActions;
    return {
      type:typeof ta,
      hasClose:typeof ta?.closeStartScreen==='function',
      hasOpen:typeof ta?.openBuyFeaturePopup==='function',
      hasBuy:typeof ta?.playBuyFeature==='function',
      hasSpin:typeof ta?.spin==='function',
      startScreenKeys:ta?.app?.startScreen?Object.keys(ta.app.startScreen):[],
      boardKeys:ta?.app?.board?Object.keys(ta.app.board):[],
      buyFeatureKeys:ta?.app?.buyFeature?Object.keys(ta.app.buyFeature):[],
    };
  });
  console.log('READY_STATE',JSON.stringify(state,null,2));

  await internal.page.evaluate(()=>window.TestActions?.closeStartScreen?.());
  await sleep(2500);
  console.log('AFTER_CLOSE',JSON.stringify(await service.capture(session.id,'after-close')));

  await internal.page.evaluate(()=>window.TestActions?.openBuyFeaturePopup?.());
  await sleep(1200);
  console.log('AFTER_OPEN_BUY',JSON.stringify(await service.capture(session.id,'after-open-buy')));

  const marker=internal.recorder.marker();
  await internal.page.evaluate(()=>window.TestActions?.playBuyFeature?.(0));
  await internal.recorder.waitForActivityAfter(marker,{timeoutMs:5000});
  await internal.recorder.waitForQuiet({quietMs:800,timeoutMs:12000});
  await sleep(500);
  console.log('AFTER_SELECT',JSON.stringify(await service.capture(session.id,'after-select-buy')));

  const events=internal.recorder.eventsAfter(marker);
  const rows=[];
  for(const req of events.filter(e=>e.type==='request'&&(e.url||'').includes('gsc=play'))){
    const res=events.find(e=>e.type==='response'&&e.requestId===req.requestId);
    const body=events.find(e=>e.type==='responsebody'&&e.requestId===req.requestId);
    rows.push({postData:req.postData,http:res?.status,body:body?.body?.slice(0,3000)||null});
  }
  console.log('BUY_NATIVE',JSON.stringify(rows,null,2));

  await service.closeSession(session.id);
}finally{
  await service.stop();
}
