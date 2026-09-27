import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';
import { extractBgamingJsonRpcInit } from '../src/providers/bgaming.js';

const PROFILES = {
  YommiRush: [
    {id:'more-pets', req:{purchased_feature:'buy_chance', modelRev:0, minExponent:2, bet_type:'bet'}},
    {id:'bonus', req:{purchased_feature:'buy_bonus', modelRev:0, minExponent:2, bet_type:'bet'}},
    {id:'super-bonus', req:{purchased_feature:'buy_bonus_and_chance', modelRev:0, minExponent:2, bet_type:'bet'}},
  ],
  SugarMix: [
    {id:'buy-bonus', req:{purchased_feature:'buy_bonus', bet_type:'default'}},
  ],
  ChickenFire: [
    {id:'chance', req:{purchased_feature:'buy_chance', bet_type:'bet'}},
    {id:'buy-60x', req:{purchased_feature:'buy_bonus', feature_id:'buy_bonus', bet_type:'bet'}},
    {id:'buy-90x', req:{purchased_feature:'buy_bonus', feature_id:'buy_super_bonus', bet_type:'bet'}},
    {id:'buy-120x', req:{purchased_feature:'buy_bonus', feature_id:'buy_ultra_bonus', bet_type:'bet'}},
  ],
  BlackbeardsBounty: [
    {id:'chance', req:{purchased_feature:'buy_chance', bet_type:'bet'}},
    {id:'buy-free-spin-random', req:{purchased_feature:'buy_bonus', bonus_multiplier_type:'freeSpinRandom'}},
    {id:'buy-seven-free-spins', req:{purchased_feature:'buy_bonus', bonus_multiplier_type:'sevenFreeSpins'}},
    {id:'buy-random-free-spins', req:{purchased_feature:'buy_bonus', bonus_multiplier_type:'randomFreeSpins'}},
  ],
  CluckingHell: [
    {id:'boost', req:{purchased_feature:'buy_chance', buy_id:'boost'}},
    {id:'cx64', req:{purchased_feature:'buy_bonus_and_chance', buy_id:'cx64'}},
    {id:'bonus', req:{purchased_feature:'buy_bonus', buy_id:'bonus'}},
    {id:'super', req:{purchased_feature:'buy_bonus', buy_id:'super'}},
  ],
  MultiRush: [
    {id:'boost', req:{purchased_feature:'buy_chance', buy_id:'boost'}},
    {id:'cx64', req:{purchased_feature:'buy_bonus_and_chance', buy_id:'cx64'}},
    {id:'bonus', req:{purchased_feature:'buy_bonus', buy_id:'bonus'}},
    {id:'super', req:{purchased_feature:'buy_bonus', buy_id:'super'}},
  ],
  WildClustersP: [
    {id:'wild-booster-x3', price:6, req:{purchased_feature:'buy_chance', bonus_buy:'wild_booster_x3'}},
    {id:'wild-booster-x5', price:24, req:{purchased_feature:'buy_chance', bonus_buy:'wild_booster_x5'}},
    {id:'full-drop', price:200, req:{purchased_feature:'buy_bonus', bonus_buy:'full_drop'}},
    {id:'drop-dead', price:92, req:{purchased_feature:'buy_bonus_and_chance', bonus_buy:'drop_dead'}},
  ],
};

const service = new BrowserService(config);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function waitInit(internal, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const init = extractBgamingJsonRpcInit(internal.recorder.eventsAfter(0));
    if (init) return init;
    await sleep(150);
  }
  return null;
}

function semanticHits(value, path = '', depth = 0, out = []) {
  if (depth > 12 || out.length >= 80 || value == null) return out;
  if (Array.isArray(value)) {
    value.slice(0,80).forEach((entry, index) => semanticHits(entry, path + '[' + index + ']', depth + 1, out));
    return out;
  }
  if (typeof value !== 'object') return out;

  for (const [key, child] of Object.entries(value)) {
    const next = path ? path + '.' + key : key;
    if (/purchas|buy_|buyId|buyFeature|feature_id|featureId|bonus_buy|bonus_multiplier|custom_field|machineId|baseBet|bet_type/i.test(key)) {
      let sample = child;
      if (child && typeof child === 'object') {
        try {
          const text = JSON.stringify(child);
          sample = text.length <= 700 ? child : text.slice(0,700);
        } catch {
          sample = String(child).slice(0,700);
        }
      }
      out.push({path:next, value:sample});
    }
    if (child && typeof child === 'object') semanticHits(child, next, depth + 1, out);
    if (out.length >= 80) break;
  }
  return out;
}

async function openFresh(game) {
  const url = 'https://demo.bgaming-network.com/play/' + game + '/FUN';
  const session = await service.createSession({
    url,
    skipSplash:false,
    captureInitialScreenshot:false,
  });
  const internal = service.sessions.get(session.id);
  const init = await waitInit(internal);
  if (!init) {
    await service.closeSession(session.id);
    throw new Error('JSONRPC init not found');
  }
  const initRequest = parse(init.request?.postData || '') || {};
  return {
    session,
    internal,
    init,
    token:initRequest?.params?.token || null,
    result:init.body?.result || {},
  };
}

async function sendPlay(internal, endpoint, payload) {
  return internal.page.evaluate(async ({endpoint, payload}) => {
    try {
      const response = await fetch(endpoint, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload),
      });
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch {}
      return {
        http_status:response.status,
        http_ok:response.ok,
        body,
        text:text.slice(0,5000),
      };
    } catch (error) {
      return {http_status:null, http_ok:false, error:error.message};
    }
  }, {endpoint, payload});
}

async function probe(task) {
  let ctx = null;
  try {
    ctx = await openFresh(task.game);
    const cfg = ctx.result.config || {};
    const bet = (cfg.bet_limits || [])[0] ?? cfg.default_bet ?? 100;
    const endpoint = ctx.init.request?.url;
    const req = {bet, ...task.mode.req};
    const payload = {
      id:crypto.randomUUID(),
      jsonrpc:'2.0',
      method:'play',
      params:{
        token:ctx.token,
        req,
      },
    };
    if (ctx.result.state_lock) payload.params.state_lock = ctx.result.state_lock;

    const response = await sendPlay(ctx.internal, endpoint, payload);
    const body = response.body || {};
    const result = body.result || null;
    const error = body.error || null;
    const hits = semanticHits(result);

    return {
      game:task.game,
      id:task.mode.id,
      declared_price_multiplier:task.mode.price ?? null,
      request:req,
      endpoint,
      http_status:response.http_status,
      accepted:Boolean(result) && !error,
      error,
      final:result?.final ?? null,
      semantic_hits:hits,
      result_keys:result ? Object.keys(result) : [],
      resp_keys:result?.resp && typeof result.resp === 'object' ? Object.keys(result.resp) : [],
    };
  } catch (error) {
    return {
      game:task.game,
      id:task.mode.id,
      request:task.mode.req,
      accepted:false,
      error:{message:error.message},
      semantic_hits:[],
    };
  } finally {
    if (ctx?.session) await service.closeSession(ctx.session.id).catch(() => {});
  }
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
      await sleep(300);
    }
  }
  await Promise.all(Array.from({length:Math.min(limit, items.length)}, worker));
  return results;
}

await service.start();
try {
  const tasks = Object.entries(PROFILES).flatMap(([game, modes]) =>
    modes.map((mode) => ({game, mode}))
  );
  const results = await pool(tasks, 4, probe);

  const byGame = {};
  for (const row of results) {
    (byGame[row.game] ||= []).push(row);
  }

  await fs.mkdir('artifacts/bg-jsonrpc-ui', {recursive:true});
  await fs.writeFile(
    'artifacts/bg-jsonrpc-ui/exact-profile-probe.json',
    JSON.stringify({profiles:PROFILES, results}, null, 2),
    'utf8',
  );

  const summary = Object.entries(byGame).map(([game, rows]) => ({
    game,
    accepted:rows.filter((row) => row.accepted).map((row) => ({
      id:row.id,
      request:row.request,
      declared_price_multiplier:row.declared_price_multiplier,
      final:row.final,
      semantic_hits:row.semantic_hits,
    })),
    rejected:rows.filter((row) => !row.accepted).map((row) => ({
      id:row.id,
      request:row.request,
      error:row.error,
    })),
  }));

  await fs.writeFile(
    'artifacts/bg-jsonrpc-ui/manifest.json',
    JSON.stringify(summary, null, 2),
    'utf8',
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await service.stop();
}
