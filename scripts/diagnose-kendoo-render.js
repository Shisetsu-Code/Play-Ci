import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const url='https://3oaks.com/api/v1/games/3_coin_volcanoes/play?lang=en';
const variants=[
  {id:'default',args:['--autoplay-policy=no-user-gesture-required']},
  {id:'swiftshader',args:[
    '--autoplay-policy=no-user-gesture-required',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader-webgl'
  ]},
  {id:'swiftshader-angle',args:[
    '--autoplay-policy=no-user-gesture-required',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader'
  ]},
  {id:'software',args:[
    '--autoplay-policy=no-user-gesture-required',
    '--disable-gpu',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader'
  ]}
];

await fs.mkdir('artifacts/kendoo-render',{recursive:true});
const results=[];

for(const variant of variants){
  const logs=[];
  const errors=[];
  let browser;
  try{
    browser=await chromium.launch({headless:true,args:variant.args});
    const context=await browser.newContext({viewport:{width:1280,height:720},deviceScaleFactor:1});
    const page=await context.newPage();
    page.on('console',m=>{
      if(['error','warning'].includes(m.type())) logs.push({type:m.type(),text:m.text().slice(0,1000)});
    });
    page.on('pageerror',e=>errors.push(e.message.slice(0,1500)));
    page.on('requestfailed',r=>logs.push({type:'requestfailed',url:r.url(),failure:r.failure()}));
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForTimeout(30000);
    const state=await page.evaluate(()=>({
      readyState:document.readyState,
      canvas:[...document.querySelectorAll('canvas')].map(c=>({w:c.width,h:c.height,rect:c.getBoundingClientRect().toJSON?.()||null})),
      board:Boolean(window.app?.board),
      preloader:(()=>{try{return window.GR?.UI?.model?.get?.('preloader_hidden')??null}catch{return null}})(),
      controls:(()=>{try{return window.GR?.UI?.model?.get?.('controls.available')??null}catch{return null}})(),
      buyVisible:(()=>{try{return window.GR?.UI?.view?.buy_feature?.visible?.()??null}catch{return null}})(),
      buyDisabled:(()=>{try{return window.GR?.UI?.view?.buy_feature?.disabled?.()??null}catch{return null}})(),
      webgl:(()=>{
        try{
          const c=document.createElement('canvas');
          const gl=c.getContext('webgl2')||c.getContext('webgl');
          return gl?{
            version:gl.getParameter(gl.VERSION),
            renderer:gl.getParameter(gl.RENDERER),
            vendor:gl.getParameter(gl.VENDOR)
          }:null;
        }catch(e){return {error:e.message}}
      })()
    }));
    await page.screenshot({path:path.join('artifacts','kendoo-render',variant.id+'.png'),timeout:45000});
    results.push({...variant,state,logs:logs.slice(-80),errors,ok:true});
    await context.close();
  }catch(error){
    results.push({...variant,ok:false,error:error.message,logs:logs.slice(-80),errors});
  }finally{
    if(browser) await browser.close().catch(()=>{});
  }
}
await fs.writeFile('artifacts/kendoo-render/results.json',JSON.stringify(results,null,2),'utf8');
console.log(JSON.stringify(results.map(r=>({id:r.id,ok:r.ok,state:r.state,error:r.error,errors:r.errors,logs:r.logs?.slice(-10)})),null,2));
