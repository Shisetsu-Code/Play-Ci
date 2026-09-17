import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BrowserService } from '../src/browser-service.js';

async function listenFixture() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/action' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echoed: JSON.parse(body) }));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
      <html><body style="margin:0;width:100vw;height:100vh;overflow:hidden">
        <button id="play" style="position:absolute;left:500px;top:300px;width:200px;height:80px">PLAY</button>
        <script>
          play.onclick = () => {
            play.remove();
            const action = document.createElement('button');
            action.id = 'action';
            action.textContent = 'ACTION';
            action.style.cssText = 'position:absolute;left:100px;top:100px;width:100px;height:100px';
            action.onclick = () => fetch('/api/action', {
              method: 'POST',
              headers: {'content-type': 'application/json'},
              body: JSON.stringify({command:'test-click'})
            });
            document.body.appendChild(action);
          };
        </script>
      </body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('skips splash, captures screenshot, clicks viewport coordinate and returns correlated request', { timeout: 30000 }, async () => {
  const fixture = await listenFixture();
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'play-ci-test-'));
  const service = new BrowserService({
    artifactDir,
    viewport: { width: 1280, height: 720 },
    navigationTimeoutMs: 10000,
    initialSettleMs: 50,
    clickSettleTimeoutMs: 2000,
    quietWindowMs: 100,
    maxBodyBytes: 1024 * 1024,
    maxMemoryEvents: 1000,
    captureSensitiveHeaders: false,
    headed: false,
  });

  try {
    const session = await service.createSession({ url: fixture.url, skipSplash: true });
    assert.equal(session.deviceScaleFactor, 1);
    assert.equal(session.splashActions.length, 1);
    assert.equal(session.splashActions[0].text, 'PLAY');
    await fs.access(path.resolve(session.screenshot.path));

    const result = await service.click(session.id, { x: 150, y: 150 });
    const request = result.requests.find((event) => event.type === 'request' && event.url.endsWith('/api/action'));
    assert.ok(request, 'expected POST /api/action in click network slice');
    assert.equal(request.method, 'POST');
    assert.equal(request.postData, JSON.stringify({ command: 'test-click' }));

    const response = result.responses.find((event) => event.requestId === request.requestId);
    assert.ok(response, 'expected correlated response');
    assert.equal(response.status, 200);
  } finally {
    await service.stop();
    await fixture.close();
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});
