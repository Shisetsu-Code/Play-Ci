import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const targets = [
  { family: 'hraymo', game: '3_african_drums', url: 'https://3oaks.com/api/v1/games/3_african_drums/play?lang=en' },
  { family: 'goreel', game: '3_aztec_temples', url: 'https://3oaks.com/api/v1/games/3_aztec_temples/play?lang=en' },
  { family: 'ratpack', game: '4_super_clover_pots', url: 'https://3oaks.com/api/v1/games/4_super_clover_pots/play?lang=en' },
  { family: 'kendoo', game: '3_coin_volcanoes', url: 'https://3oaks.com/api/v1/games/3_coin_volcanoes/play?lang=en' },
  { family: 'enjoy', game: '3_superpower_diamonds', url: 'https://3oaks.com/api/v1/games/3_superpower_diamonds/play?lang=en' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const service = new BrowserService(config);

await service.start();
try {
  const manifest = [];
  for (const target of targets) {
    const session = await service.createSession({
      url: target.url,
      skipSplash: false,
      captureInitialScreenshot: true,
    });
    const internal = service.sessions.get(session.id);
    const before = session.screenshot;

    await internal.page.mouse.click(config.viewport.width / 2, config.viewport.height - 50);
    await sleep(2500);
    const game = await service.capture(session.id, 'game');

    const outDir = path.join('artifacts','visual-families',target.family);
    await fs.mkdir(outDir,{recursive:true});
    await fs.copyFile(path.resolve(before.path), path.join(outDir,'01-start.png'));
    await fs.copyFile(path.resolve(game.path), path.join(outDir,'02-game.png'));

    manifest.push({
      ...target,
      sessionId: session.id,
      before,
      game,
      viewport: config.viewport,
    });
    await service.closeSession(session.id);
  }

  await fs.mkdir(path.join('artifacts','visual-families'),{recursive:true});
  await fs.writeFile(
    path.join('artifacts','visual-families','manifest.json'),
    JSON.stringify(manifest,null,2),
    'utf8'
  );
} finally {
  await service.stop();
}
