import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { BrowserService } from './browser-service.js';
import { errorJson, json, readJson } from './http-utils.js';

export function createApiServer(service, { host = config.host, port = config.port } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const base = `http://${req.headers.host || `${host}:${port}`}`;
      const url = new URL(req.url, base);
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, service: 'play-ci', sessions: service.sessions.size });
      }

      if (req.method === 'POST' && url.pathname === '/v1/sessions') {
        const body = await readJson(req);
        const session = await service.createSession(body);
        return json(res, 201, { ok: true, ...session });
      }

      if (req.method === 'POST' && url.pathname === '/v1/sessions/batch') {
        const body = await readJson(req);
        if (!Array.isArray(body.urls) || body.urls.length === 0 || body.urls.length > 20) {
          throw Object.assign(new Error('urls must be an array with 1..20 entries'), { statusCode: 400 });
        }
        const sessions = [];
        for (const target of body.urls) {
          sessions.push(await service.createSession({
            url: target,
            skipSplash: body.skipSplash ?? true,
            bootstrapClicks: body.bootstrapClicks ?? [],
          }));
        }
        return json(res, 201, { ok: true, sessions });
      }

      if (parts[0] === 'v1' && parts[1] === 'sessions' && parts[2]) {
        const id = parts[2];

        if (req.method === 'POST' && parts[3] === 'click' && parts.length === 4) {
          const result = await service.click(id, await readJson(req));
          return json(res, 200, { ok: true, ...result });
        }

        if (req.method === 'POST' && parts[3] === 'screenshot' && parts.length === 4) {
          const body = await readJson(req);
          const screenshot = await service.capture(id, body.label || 'manual');
          return json(res, 200, { ok: true, sessionId: id, screenshot });
        }

        if (req.method === 'GET' && parts[3] === 'network' && parts.length === 4) {
          return json(res, 200, { ok: true, ...service.getNetwork(id, url.searchParams.get('after') || 0) });
        }

        if (req.method === 'GET' && parts[3] === 'artifacts' && parts[4] && parts.length === 5) {
          const file = service.getArtifactPath(id, decodeURIComponent(parts[4]));
          const stat = fs.statSync(file);
          res.writeHead(200, {
            'content-type': 'image/png',
            'content-length': stat.size,
            'cache-control': 'no-store',
          });
          fs.createReadStream(file).pipe(res);
          return;
        }

        if (req.method === 'DELETE' && parts.length === 3) {
          const existed = await service.closeSession(id);
          return json(res, existed ? 200 : 404, { ok: existed, sessionId: id });
        }
      }

      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      return errorJson(res, error);
    }
  });

  return {
    server,
    async listen() {
      await service.start();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      return typeof address === 'object' && address ? address : { address: host, port };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await service.stop();
    },
  };
}

async function main() {
  const service = new BrowserService(config);
  const api = createApiServer(service);
  const address = await api.listen();
  const shownHost = address.address === '::' ? 'localhost' : address.address;
  console.log(`Play-Ci listening on http://${shownHost}:${address.port}`);
  console.log(`Artifacts: ${config.artifactDir}`);
  console.log(`Viewport: ${config.viewport.width}x${config.viewport.height}, DPR=1`);

  const shutdown = async () => {
    await api.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
