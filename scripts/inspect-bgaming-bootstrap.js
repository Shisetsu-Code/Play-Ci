import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const targets = [
  'https://demo.bgaming-network.com/play/ThreeLuckyMonkeysHoldAndWin/FUN?server=demo',
  'https://demo.bgaming-network.com/play/AliceWonderLuck/FUN?server=demo',
  'https://demo.bgaming-network.com/play/AlienFruits3/FUN?server=demo',
  'https://demo.bgaming-network.com/play/AlwaysUpX10000/FUN?server=demo',
  'https://demo.bgaming-network.com/play/BookOfCats/FUN?server=demo',
  'https://demo.bgaming-network.com/play/DiceMillion/FUN?server=demo',
  'https://demo.bgaming-network.com/play/LuckyLadyMoonMegaways/FUN?server=demo',
  'https://demo.bgaming-network.com/play/YommiRush/FUN',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const service = new BrowserService(config);

function parseBody(event) {
  try { return JSON.parse(event.body); } catch { return null; }
}

function summarize(value, depth = 0) {
  if (depth > 5) return typeof value;
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      sample: value.slice(0, 5).map((v) => summarize(v, depth + 1)),
    };
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = summarize(v, depth + 1);
    return out;
  }
  return value;
}

await service.start();
try {
  const results = [];
  for (const url of targets) {
    const session = await service.createSession({url, skipSplash:false, captureInitialScreenshot:false});
    const internal = service.sessions.get(session.id);
    try {
      await sleep(2500);
      const events = internal.recorder.eventsAfter(0);
      const responses = [];
      for (const ev of events) {
        if (ev.type !== 'responsebody' || !ev.body) continue;
        if (!/bgaming-network\.com\/api\//i.test(ev.url || '')) continue;
        const body = parseBody(ev);
        if (!body) continue;
        const req = events.find((r) => r.type === 'request' && r.requestId === ev.requestId);
        responses.push({
          url: ev.url,
          request: req ? {method:req.method, url:req.url, headers:req.headers, postData:req.postData} : null,
          keys: Object.keys(body),
          shape: summarize(body),
          body,
        });
      }
      results.push({target:url, responses});
    } finally {
      await service.closeSession(session.id);
    }
    await sleep(400);
  }
  await fs.mkdir('artifacts/bg-bootstrap', {recursive:true});
  await fs.writeFile('artifacts/bg-bootstrap/bootstrap.json', JSON.stringify(results,null,2),'utf8');
  console.log(JSON.stringify(results.map(r => ({
    target:r.target,
    responses:r.responses.map(x => ({url:x.url, keys:x.keys, shape:x.shape}))
  })), null, 2));
} finally {
  await service.stop();
}
