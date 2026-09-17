import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const url = 'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en';
const service = new BrowserService(config);
try {
  const session = await service.createSession({ url, skipSplash: true });
  console.log('READY', JSON.stringify(session, null, 2));

  const enter = await service.click(session.id, {
    x: 640,
    y: 670,
    settleTimeoutMs: 8000,
  });
  await session.page?.waitForTimeout?.(1500);
  console.log('ENTER', JSON.stringify(enter, null, 2));

  await service.closeSession(session.id);
} finally {
  await service.stop();
}
