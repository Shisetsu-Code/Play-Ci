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
    const opened=[];
    context.on('page',p=>opened.push(p));
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForTimeout(2500);

    const candidates=await page.locator('a,button,[role="button"]').evaluateAll(els=>els.map((el,index)=>({
      index,
      text:(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim(),
      href:el.href||null,
      tag:el.tagName,
    })).filter(x=>/play demo/i.test(x.text)));

    let click=null;
    let finalUrls=[];
    if(candidates.length){
      const loc=page.locator('a,button,[role="button"]').nth(candidates[0].index);
      try{
        await loc.click({timeout:5000});
        click={ok:true,candidate:candidates[0]};
      }catch(error){click={ok:false,error:error.message,candidate:candidates[0]};}
      await page.waitForTimeout(3500);
      finalUrls=[page.url(),...opened.map(p=>p.url())];
      for(const p of opened){
        try{await p.waitForLoadState('domcontentloaded',{timeout:5000});}catch{}
        finalUrls.push(p.url());
      }
    }

    const performanceUrls=await page.evaluate(()=>
      performance.getEntriesByType('resource').map(e=>e.name).filter(u=>/bgaming|demo/i.test(u))
    ).catch(()=>[]);

    results.push({id,url,candidates,click,finalUrls:[...new Set(finalUrls)],performanceUrls:[...new Set(performanceUrls)]});
    await context.close();
  }
}finally{
  await browser.close();
}

await fs.mkdir('artifacts/bg-official-demo-resolver',{recursive:true});
await fs.writeFile('artifacts/bg-official-demo-resolver/results.json',JSON.stringify(results,null,2),'utf8');
console.log(JSON.stringify(results,null,2));
