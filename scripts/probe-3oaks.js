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
  console.log('ENTER', JSON.stringify({
    click: enter.click,
    requests: enter.requests,
    responses: enter.responses,
    screenshot: enter.screenshot,
  }, null, 2));

  await new Promise((resolve) => setTimeout(resolve, 2500));
  const after = await service.capture(session.id, 'after-enter');
  console.log('AFTER_ENTER', JSON.stringify(after, null, 2));

  await service.closeSession(session.id);
} finally {
  await service.stop();
}
