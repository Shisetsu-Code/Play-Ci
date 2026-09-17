import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const url = 'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en';
const service = new BrowserService(config);
try {
  const session = await service.createSession({ url, skipSplash: true });

  await service.click(session.id, { x: 640, y: 670, settleTimeoutMs: 8000 });
  await sleep(2500);
  console.log('GAME', JSON.stringify(await service.capture(session.id, 'game'), null, 2));

  const bonus = await service.click(session.id, {
    x: 1195,
    y: 233,
    settleTimeoutMs: 3000,
  });
  console.log('BONUS_CLICK', JSON.stringify({
    click: bonus.click,
    requests: bonus.requests,
    responses: bonus.responses,
  }, null, 2));

  await sleep(1200);
  console.log('BONUS_MENU', JSON.stringify(await service.capture(session.id, 'bonus-menu'), null, 2));

  await service.closeSession(session.id);
} finally {
  await service.stop();
}
