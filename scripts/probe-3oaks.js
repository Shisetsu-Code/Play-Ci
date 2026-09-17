import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const url = 'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en';
const service = new BrowserService(config);
try {
  const session = await service.createSession({
    url,
    skipSplash: true,
    bootstrapClicks: [{ x: 640, y: 360 }],
  });
  console.log(JSON.stringify(session, null, 2));
  await service.closeSession(session.id);
} finally {
  await service.stop();
}
