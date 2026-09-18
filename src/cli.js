import fs from 'node:fs/promises';
import { config } from './config.js';
import { BrowserService } from './browser-service.js';

function usage() {
  console.error('Usage:');
  console.error('  npm run capture -- <url>');
  console.error('  npm run batch -- <urls.txt>');
}

async function capture(service, url) {
  const session = await service.createSession({ url, skipSplash: true });
  console.log(JSON.stringify(session, null, 2));
  return session;
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (!command || !argument) {
    usage();
    process.exitCode = 2;
    return;
  }

  const service = new BrowserService(config);
  try {
    if (command === 'capture') {
      const session = await capture(service, argument);
      await service.closeSession(session.id);
      return;
    }

    if (command === 'batch') {
      const text = await fs.readFile(argument, 'utf8');
      const urls = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
      for (const url of urls) {
        const session = await capture(service, url);
        await service.closeSession(session.id);
      }
      return;
    }

    usage();
    process.exitCode = 2;
  } finally {
    await service.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
