import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const targets = [
  { family: 'goreel', url: 'https://3oaks.com/api/v1/games/dj_tiger_x1000/play?lang=en' },
  { family: 'ratpack', url: 'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en' },
];

const service = new BrowserService(config);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function inspect(page, expr) {
  return page.evaluate((expression) => {
    let obj;
    try { obj = (0, eval)(expression); } catch { return null; }
    if (!obj) return null;
    const source = (fn) => {
      try { return Function.prototype.toString.call(fn).slice(0,1800); } catch { return null; }
    };
    const own = Object.getOwnPropertyNames(obj);
    const proto = Object.getPrototypeOf(obj);
    const names = [...new Set([...own, ...(proto ? Object.getOwnPropertyNames(proto) : [])])];
    const functions = {};
    const values = {};
    for (const name of names) {
      let v;
      try { v = obj[name]; } catch { continue; }
      if (typeof v === 'function') functions[name] = source(v);
      else if (v == null || ['number','string','boolean'].includes(typeof v)) values[name] = v;
    }
    return { own, proto: proto ? Object.getOwnPropertyNames(proto) : [], functions, values };
  }, expr);
}

async function one(target) {
  const session = await service.createSession({url:target.url,skipSplash:false,captureInitialScreenshot:false});
  const internal = service.sessions.get(session.id);
  try {
    await sleep(2500);
    await internal.page.evaluate(() => {
      try {
        if (typeof window.TestActions?.closeStartScreen === 'function') {
          window.TestActions.closeStartScreen();
          return;
        }
      } catch {}
      try { window.app?.startScreen?.skip?.(); } catch {}
    });
    await sleep(1400);

    const open = await internal.page.evaluate(() => {
      const attempts = [
        ['TestActions.openBonusShopPopup', () => window.TestActions?.openBonusShopPopup],
        ['GR.UI.view.shop_button.click', () => window.GR?.UI?.view?.shop_button?.click],
      ];
      for (const [name,getter] of attempts) {
        let fn;
        try { fn=getter(); } catch { continue; }
        if (typeof fn !== 'function') continue;
        try {
          if (name.startsWith('TestActions')) fn.call(window.TestActions);
          else fn.call(window.GR.UI.view.shop_button);
          return {ok:true,method:name};
        } catch (e) { return {ok:false,method:name,error:e.message}; }
      }
      return {ok:false,method:null};
    });
    await sleep(1200);

    const exprs=[
      'window.TestActions',
      'window.app?.board?.bonusShopPopup',
      'window.app?.board?.shop',
      'window.GR?.UI?.view?.shop_button',
      'window.GR?.UI?.model',
    ];
    const objects={};
    for(const expr of exprs) objects[expr]=await inspect(internal.page,expr);

    const popupDeep=await internal.page.evaluate(() => {
      const p=window.app?.board?.bonusShopPopup;
      if(!p) return null;
      const inspectChild=(obj) => {
        if(!obj) return null;
        let keys=[];
        try {keys=Object.getOwnPropertyNames(obj);} catch {return null;}
        const out={};
        for(const k of keys){
          let v; try{v=obj[k];}catch{continue;}
          if(v==null||['string','number','boolean'].includes(typeof v)) out[k]=v;
          else if(Array.isArray(v)) out[k]={type:'array',length:v.length,items:v.slice(0,10).map((it,i)=>({
            i,
            ctor:it?.constructor?.name||null,
            keys:it&&(typeof it==='object'||typeof it==='function')?(()=>{try{return Object.getOwnPropertyNames(it).slice(0,80)}catch{return[]}})():[]
          }))};
          else if(typeof v==='object' && /option|container|button|btn|bet/i.test(k)) out[k]={
            ctor:v.constructor?.name||null,
            keys:(()=>{try{return Object.getOwnPropertyNames(v).slice(0,100)}catch{return[]}})()
          };
        }
        return out;
      };
      return inspectChild(p);
    });

    return {...target,open,objects,popupDeep};
  } finally {
    await service.closeSession(session.id);
  }
}

await service.start();
try{
  const results=[];
  for(const t of targets) results.push(await one(t));
  await fs.mkdir('artifacts/booster-inspection',{recursive:true});
  await fs.writeFile('artifacts/booster-inspection/boosters.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results,null,2));
}finally{await service.stop();}
