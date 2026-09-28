import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractBgamingBootstrap, summarizeBgamingBootstrap } from '../src/providers/bgaming.js';

const targets = {
  alice: 'https://demo.bgaming-network.com/play/AliceWonderLuck/FUN?server=demo',
  monkeys: 'https://demo.bgaming-network.com/play/ThreeLuckyMonkeysHoldAndWin/FUN?server=demo',
  cats: 'https://demo.bgaming-network.com/play/BookOfCats/FUN?server=demo',
};

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const service=new BrowserService(config);

function balanceValue(body) {
  const b=body?.balance;
  if (Number.isFinite(Number(b))) return Number(b);
  if (b && typeof b==='object') {
    const wallet=Number(b.wallet||0), game=Number(b.game||0);
    if (Number.isFinite(wallet)&&Number.isFinite(game)) return wallet+game;
  }
  return null;
}

async function fresh(url) {
  const s=await service.createSession({url,skipSplash:false,captureInitialScreenshot:false});
  const internal=service.sessions.get(s.id);
  const deadline=Date.now()+10000;
  let start=null;
  while(!start && Date.now()<deadline){
    start=extractBgamingBootstrap(internal.recorder.eventsAfter(0));
    if(!start) await sleep(150);
  }
  if(!start){await service.closeSession(s.id); throw new Error('bootstrap missing');}
  return {s,internal,start,protocol:summarizeBgamingBootstrap(start)};
}

async function sendOne(url, options) {
  const {s,internal,start,protocol}=await fresh(url);
  try{
    const headers={
      'content-type':'application/json',
      referer:start.request?.headers?.referer || 'https://demo.bgaming-network.com/',
    };
    const csrf=start.request?.headers?.['x-csrf-token'];
    if(csrf) headers['x-csrf-token']=csrf;
    const payload={command:'spin',options};
    const response=await internal.context.request.post(start.request.url,{
      headers,
      data:JSON.stringify(payload),
      failOnStatusCode:false,
    });
    const text=await response.text();
    let body=null; try{body=JSON.parse(text)}catch{body={raw:text.slice(0,2000)}}
    const before=balanceValue(start.body), after=balanceValue(body);
    return {
      url,
      generation:protocol.generation,
      default_bet_raw:protocol.default_bet_raw,
      payload,
      http:response.status(),
      before_balance:before,
      after_balance:after,
      cost_raw:Number.isFinite(before)&&Number.isFinite(after)?before-after:null,
      cost_over_bet:Number.isFinite(before)&&Number.isFinite(after)&&Number(options.bet)>0
        ? (before-after)/Number(options.bet):null,
      response_keys:body&&typeof body==='object'?Object.keys(body):[],
      response:body,
    };
  }finally{
    await service.closeSession(s.id);
    await sleep(250);
  }
}

await service.start();
try{
  const results=[];

  // Normal wire proof.
  for(const [name,url] of Object.entries(targets)){
    const {s,protocol}=await fresh(url);
    await service.closeSession(s.id);
    results.push({case:`${name}:spin`,result:await sendOne(url,{bet:protocol.default_bet_raw})});
  }

  const aliceBet=100;
  results.push({case:'alice:freespin_buy:decl0->wire1',result:await sendOne(targets.alice,{bet:aliceBet,purchased_feature:'freespin_buy',purchased_feature_level:'1'})});
  results.push({case:'alice:freespin_buy:decl0->wire0',result:await sendOne(targets.alice,{bet:aliceBet,purchased_feature:'freespin_buy',purchased_feature_level:'0'})});
  results.push({case:'alice:freespin_buy:decl1->wire2',result:await sendOne(targets.alice,{bet:aliceBet,purchased_feature:'freespin_buy',purchased_feature_level:'2'})});
  results.push({case:'alice:freespin_buy:decl1->wire1',result:await sendOne(targets.alice,{bet:aliceBet,purchased_feature:'freespin_buy',purchased_feature_level:'1'})});
  results.push({case:'alice:bonus_chance',result:await sendOne(targets.alice,{bet:aliceBet,purchased_feature:'bonus_chance'})});
  results.push({case:'alice:freespin_chance-alias',result:await sendOne(targets.alice,{bet:aliceBet,purchased_feature:'freespin_chance'})});

  const monkeyBet=200;
  results.push({case:'monkeys:bonus_buy:decl0->wire1',result:await sendOne(targets.monkeys,{bet:monkeyBet,purchased_feature:'bonus_buy',purchased_feature_level:'1'})});
  results.push({case:'monkeys:bonus_buy:decl1->wire2',result:await sendOne(targets.monkeys,{bet:monkeyBet,purchased_feature:'bonus_buy',purchased_feature_level:'2'})});
  results.push({case:'monkeys:bonus_chance',result:await sendOne(targets.monkeys,{bet:monkeyBet,purchased_feature:'bonus_chance'})});

  const catsBet=1;
  for(const feature of ['buy_feature','freespin_buy','bonus_buy','buy_bonus']){
    results.push({case:`cats:${feature}`,result:await sendOne(targets.cats,{bet:catsBet,purchased_feature:feature})});
  }

  await fs.mkdir('artifacts/bg-runtime-probe',{recursive:true});
  await fs.writeFile('artifacts/bg-runtime-probe/results.json',JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results.map(x=>({
    case:x.case,http:x.result.http,cost_over_bet:x.result.cost_over_bet,
    keys:x.result.response_keys,
    errors:x.result.response?.errors||x.result.response?.error||null,
    flow:x.result.response?.flow||null,
    game:x.result.response?.game||null
  })),null,2));
} finally {
  await service.stop();
}
