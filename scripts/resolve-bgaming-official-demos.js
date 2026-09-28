import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const games=[
  ['PrincessOfSky','https://bgaming.com/games/princess-of-sky'],
  ['PrincessRoyal','https://bgaming.com/games/princess-royal'],
  ['ScrollOfAdventure','https://bgaming.com/games/scroll-of-adventure'],
];

const browser=await chromium.launch({headless:true});
const results=[];
try{
  for(const [id,url] of games){
    const context=await browser.newContext({viewport:{width:1280,height:720}});
    const page=await context.newPage();
    const popupPages=[];
    context.on('page',p=>popupPages.push(p));

    await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForTimeout(1800);

    const ageGate=await page.locator('#popup-age-check-acf-block-679b86d3e4286, .popup-age-check').first().evaluate(el=>({
      text:(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim(),
      buttons:[...el.querySelectorAll('button,a,[role="button"]')].map((x,i)=>({
        i,text:(x.innerText||x.textContent||'').replace(/\s+/g,' ').trim(),
        href:x.href||null,className:x.className||null
      }))
    })).catch(()=>null);

    if(ageGate){
      const gateButtons=page.locator('#popup-age-check-acf-block-679b86d3e4286 button, #popup-age-check-acf-block-679b86d3e4286 a, .popup-age-check button, .popup-age-check a');
      const n=await gateButtons.count();
      for(let i=0;i<n;i++){
        const b=gateButtons.nth(i);
        const text=((await b.innerText().catch(()=>''))||'').trim();
        if(/yes|enter|18|accept|continue|i am|confirm/i.test(text)){
          await b.click({force:true}).catch(()=>{});
          await page.waitForTimeout(700);
          break;
        }
      }
    }

    const demoSection=await page.locator('#game-demo').evaluate(el=>({
      html:el.outerHTML.slice(0,20000),
      buttons:[...el.querySelectorAll('button,a,[role="button"]')].map((x,i)=>({
        i,tag:x.tagName,text:(x.innerText||x.textContent||'').replace(/\s+/g,' ').trim(),
        href:x.href||null,
        attrs:Object.fromEntries([...x.attributes].map(a=>[a.name,a.value]))
      })),
      iframes:[...el.querySelectorAll('iframe')].map(x=>({src:x.src,attrs:Object.fromEntries([...x.attributes].map(a=>[a.name,a.value]))}))
    })).catch(()=>null);

    const beforeResources=await page.evaluate(()=>performance.getEntriesByType('resource').map(e=>e.name));
    let click={ok:false};
    const demoButton=page.locator('#game-demo button').filter({hasText:/play demo/i}).first();
    if(await demoButton.count()){
      try{
        await demoButton.click({force:true,timeout:5000});
        click={ok:true,method:'game-demo button force'};
      }catch(error){click={ok:false,error:error.message};}
    }else{
      const anchor=page.locator('a[href="#game-demo"]').first();
      try{
        await anchor.click({force:true,timeout:5000});
        await page.waitForTimeout(300);
        const anyButton=page.locator('button').filter({hasText:/play demo/i}).first();
        await anyButton.click({force:true,timeout:5000});
        click={ok:true,method:'anchor then button force'};
      }catch(error){click={ok:false,error:error.message};}
    }

    await page.waitForTimeout(5000);
    for(const p of popupPages){
      try{await p.waitForLoadState('domcontentloaded',{timeout:5000});}catch{}
    }

    const after=await page.evaluate(()=>({
      iframes:[...document.querySelectorAll('iframe')].map(x=>({src:x.src,attrs:Object.fromEntries([...x.attributes].map(a=>[a.name,a.value]))})),
      resources:performance.getEntriesByType('resource').map(e=>e.name),
      gameDemo:document.querySelector('#game-demo')?.outerHTML?.slice(0,25000)||null,
    }));

    const newResources=after.resources.filter(x=>!beforeResources.includes(x));
    results.push({
      id,url,ageGate,demoSection,click,
      finalUrls:[...new Set([page.url(),...popupPages.map(p=>p.url())])],
      iframes:after.iframes,
      newResources:newResources.filter(u=>/demo|bgaming|game|play/i.test(u)),
      gameDemoAfter:after.gameDemo,
    });
    await context.close();
  }
}finally{await browser.close();}

await fs.mkdir('artifacts/bg-official-demo-resolver',{recursive:true});
await fs.writeFile('artifacts/bg-official-demo-resolver/results.json',JSON.stringify(results,null,2),'utf8');
console.log(JSON.stringify(results.map(r=>({
  id:r.id,click:r.click,finalUrls:r.finalUrls,
  iframes:r.iframes.map(x=>x.src),
  newResources:r.newResources,
  demoButtons:r.demoSection?.buttons||[],
})),null,2));
