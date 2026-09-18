import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { NetworkRecorder } from './network-recorder.js';
import { skipSafeSplash } from './splash-skipper.js';

function validateHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error('url must be an absolute http(s) URL'), { statusCode: 400 });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw Object.assign(new Error('url must use http or https'), { statusCode: 400 });
  }
  return url.toString();
}

function validateCoordinate(name, value, max) {
  if (!Number.isFinite(value) || value < 0 || value >= max) {
    throw Object.assign(new Error(`${name} must be within [0, ${max})`), { statusCode: 400 });
  }
  return value;
}

function clampInt(value, fallback, min, max) {
  if (value == null) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export class BrowserService {
  constructor(options) {
    this.options = options;
    this.browser = null;
    this.sessions = new Map();
  }

  async start() {
    if (this.browser) return;
    await fs.mkdir(this.options.artifactDir, { recursive: true });
    this.browser = await chromium.launch({
      headless: !this.options.headed,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
  }

  async stop() {
    const ids = [...this.sessions.keys()];
    await Promise.allSettled(ids.map((id) => this.closeSession(id)));
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  #getSession(id) {
    const session = this.sessions.get(id);
    if (!session) {
      throw Object.assign(new Error(`unknown session: ${id}`), { statusCode: 404 });
    }
    return session;
  }

  #publicSession(session, screenshot = null) {
    return {
      id: session.id,
      url: session.page.url(),
      originalUrl: session.originalUrl,
      createdAt: session.createdAt,
      viewport: this.options.viewport,
      deviceScaleFactor: 1,
      splashActions: session.splashActions,
      network: {
        marker: session.recorder.marker(),
        logFile: path.relative(process.cwd(), session.networkFile),
      },
      screenshot,
    };
  }

  async createSession({ url, skipSplash = true, bootstrapClicks = [], captureInitialScreenshot = true } = {}) {
    await this.start();
    const targetUrl = validateHttpUrl(url);
    const id = crypto.randomUUID();
    const sessionDir = path.join(this.options.artifactDir, id);
    await fs.mkdir(sessionDir, { recursive: true });

    const context = await this.browser.newContext({
      viewport: this.options.viewport,
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: false,
      serviceWorkers: 'allow',
    });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);
    page.setDefaultTimeout(Math.min(10000, this.options.navigationTimeoutMs));
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));

    const networkFile = path.join(sessionDir, 'network.jsonl');
    const recorder = new NetworkRecorder(page, {
      outputFile: networkFile,
      maxBodyBytes: this.options.maxBodyBytes,
      maxMemoryEvents: this.options.maxMemoryEvents,
      captureSensitiveHeaders: this.options.captureSensitiveHeaders,
    });

    const session = {
      id,
      originalUrl: targetUrl,
      createdAt: new Date().toISOString(),
      context,
      page,
      recorder,
      networkFile,
      sessionDir,
      screenshotCounter: 0,
      splashActions: [],
    };
    this.sessions.set(id, session);

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      if (this.options.initialSettleMs > 0) {
        await page.waitForTimeout(this.options.initialSettleMs);
      }

      for (const point of bootstrapClicks) {
        validateCoordinate('bootstrapClicks[].x', point.x, this.options.viewport.width);
        validateCoordinate('bootstrapClicks[].y', point.y, this.options.viewport.height);
        await page.mouse.click(point.x, point.y);
        if (this.options.clickObservationMs > 0) {
          await page.waitForTimeout(this.options.clickObservationMs);
        }
        await recorder.waitForQuiet({
          quietMs: this.options.quietWindowMs,
          timeoutMs: this.options.clickSettleTimeoutMs,
        });
      }

      if (skipSplash) {
        session.splashActions = await skipSafeSplash(page, {
          viewport: this.options.viewport,
          maxClicks: 1,
          timeoutMs: this.options.splashTimeoutMs ?? 8000,
          settleMs: Math.min(1000, this.options.initialSettleMs),
        });
      }

      await recorder.waitForQuiet({
        quietMs: this.options.quietWindowMs,
        timeoutMs: this.options.clickSettleTimeoutMs,
      });

      const screenshot = captureInitialScreenshot ? await this.capture(id, 'ready') : null;
      return this.#publicSession(session, screenshot);
    } catch (error) {
      await this.closeSession(id).catch(() => {});
      throw error;
    }
  }

  async capture(id, label = 'capture') {
    const session = this.#getSession(id);
    session.screenshotCounter += 1;
    const safeLabel = String(label).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'capture';
    const filename = `${String(session.screenshotCounter).padStart(4, '0')}-${safeLabel}.png`;
    const absolutePath = path.join(session.sessionDir, filename);

    await session.page.screenshot({
      path: absolutePath,
      type: 'png',
      fullPage: false,
      animations: 'disabled',
      caret: 'hide',
      timeout: this.options.navigationTimeoutMs,
    });

    return {
      filename,
      path: path.relative(process.cwd(), absolutePath),
      url: `/v1/sessions/${id}/artifacts/${encodeURIComponent(filename)}`,
      width: this.options.viewport.width,
      height: this.options.viewport.height,
      coordinateSpace: 'viewport-css-px=dpr1-png-px',
      pageUrl: session.page.url(),
      capturedAt: new Date().toISOString(),
    };
  }

  async click(id, {
    x,
    y,
    button = 'left',
    clickCount = 1,
    settleTimeoutMs,
    observeMs,
    captureScreenshot = true,
  } = {}) {
    const session = this.#getSession(id);
    validateCoordinate('x', x, this.options.viewport.width);
    validateCoordinate('y', y, this.options.viewport.height);
    if (!['left', 'middle', 'right'].includes(button)) {
      throw Object.assign(new Error('button must be left, middle, or right'), { statusCode: 400 });
    }

    const marker = session.recorder.marker();
    const startedAt = new Date().toISOString();
    await session.page.mouse.click(x, y, {
      button,
      clickCount: clampInt(clickCount, 1, 1, 3),
    });

    const observationMs = clampInt(observeMs, this.options.clickObservationMs, 0, 10000);
    const activity = await session.recorder.waitForActivityAfter(marker, { timeoutMs: observationMs });

    const quiet = await session.recorder.waitForQuiet({
      quietMs: this.options.quietWindowMs,
      timeoutMs: clampInt(settleTimeoutMs, this.options.clickSettleTimeoutMs, 250, 30000),
    });
    const screenshot = captureScreenshot
      ? await this.capture(id, `click-${Math.round(x)}-${Math.round(y)}`)
      : null;

    const events = session.recorder.eventsAfter(marker);
    return {
      sessionId: id,
      click: { x, y, button, clickCount: clampInt(clickCount, 1, 1, 3), observeMs: observationMs, startedAt },
      networkMarkerBefore: marker,
      networkMarkerAfter: session.recorder.marker(),
      activity,
      quiet,
      requests: events.filter((event) => event.type === 'request'),
      responses: events.filter((event) => event.type === 'response'),
      events,
      screenshot,
      pageUrl: session.page.url(),
    };
  }

  getNetwork(id, after = 0) {
    const session = this.#getSession(id);
    const marker = Number.isFinite(Number(after)) ? Math.max(0, Number(after)) : 0;
    return {
      sessionId: id,
      after: marker,
      latest: session.recorder.marker(),
      events: session.recorder.eventsAfter(marker),
    };
  }

  getArtifactPath(id, filename) {
    const session = this.#getSession(id);
    const basename = path.basename(filename);
    if (basename !== filename || !basename.endsWith('.png')) {
      throw Object.assign(new Error('invalid artifact filename'), { statusCode: 400 });
    }
    return path.join(session.sessionDir, basename);
  }

  async closeSession(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await session.recorder.close().catch(() => {});
    await session.context.close().catch(() => {});
    return true;
  }
}
