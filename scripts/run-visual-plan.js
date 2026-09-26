import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { BrowserService } from '../src/browser-service.js';

const PLAN_FILE = path.resolve(process.env.VISUAL_PLAN_FILE || 'analysis/visual-plan.json');
const OUTPUT_DIR = path.resolve(process.env.VISUAL_OUTPUT_DIR || 'artifacts/visual-plan');
const MAX_JOBS = 20;
const MAX_STEPS = 80;

function assertFinite(name, value) {
  if (!Number.isFinite(Number(value))) throw new Error(`${name} must be finite`);
  return Number(value);
}

function safeId(value) {
  const id = String(value || '').trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '');
  if (!id) throw new Error('job.id is required');
  return id.slice(0, 80);
}

function validatePlan(plan) {
  if (!plan || plan.version !== 1 || !Array.isArray(plan.jobs)) {
    throw new Error('visual plan must be { version: 1, jobs: [...] }');
  }
  if (plan.jobs.length > MAX_JOBS) throw new Error(`visual plan exceeds ${MAX_JOBS} jobs`);

  const ids = new Set();
  return {
    version: 1,
    jobs: plan.jobs.map((job, jobIndex) => {
      const id = safeId(job.id);
      if (ids.has(id)) throw new Error(`duplicate job id: ${id}`);
      ids.add(id);

      let url;
      try { url = new URL(job.url).toString(); } catch { throw new Error(`job ${id}: invalid url`); }
      if (!['http:', 'https:'].includes(new URL(url).protocol)) {
        throw new Error(`job ${id}: url must use http/https`);
      }

      const steps = Array.isArray(job.steps) ? job.steps : [];
      if (steps.length > MAX_STEPS) throw new Error(`job ${id}: exceeds ${MAX_STEPS} steps`);

      return {
        id,
        url,
        metadata: job.metadata && typeof job.metadata === 'object' ? job.metadata : {},
        steps: steps.map((step, stepIndex) => {
          const type = String(step.type || '').toLowerCase();
          if (!['wait','capture','click'].includes(type)) {
            throw new Error(`job ${id} step ${stepIndex}: unsupported type ${type}`);
          }
          if (type === 'wait') {
            return {
              type,
              ms: Math.max(0, Math.min(30000, Math.trunc(assertFinite('wait.ms', step.ms)))),
              label: step.label || `wait-${stepIndex}`,
            };
          }
          if (type === 'capture') {
            return { type, label: step.label || `capture-${stepIndex}` };
          }

          const x = assertFinite('click.x', step.x);
          const y = assertFinite('click.y', step.y);
          if (x < 0 || x >= config.viewport.width || y < 0 || y >= config.viewport.height) {
            throw new Error(`job ${id} step ${stepIndex}: coordinate outside viewport`);
          }
          return {
            type,
            x,
            y,
            button: step.button || 'left',
            clickCount: step.clickCount ?? 1,
            observeMs: step.observeMs ?? config.clickObservationMs,
            settleTimeoutMs: step.settleTimeoutMs ?? config.clickSettleTimeoutMs,
            waitAfterMs: Math.max(0, Math.min(30000, Math.trunc(Number(step.waitAfterMs || 0)))),
            label: step.label || `click-${stepIndex}`,
          };
        }),
      };
    }),
  };
}

function economicEvents(events) {
  return events.filter((event) => {
    if (event.type === 'request') {
      const body = event.postData || '';
      return /bet|spin|buy|wager|stake|bonus|feature|ante|play/i.test(body) ||
        /play|spin|bet|game/i.test(event.url || '');
    }
    if (['response','responsebody','requestfinished','requestfailed'].includes(event.type)) {
      return true;
    }
    return false;
  });
}

async function copyScreenshot(screenshot, jobDir, filename) {
  if (!screenshot?.path) return null;
  const src = path.resolve(screenshot.path);
  const dest = path.join(jobDir, filename);
  await fs.copyFile(src, dest);
  return path.relative(process.cwd(), dest);
}

async function runJob(service, job) {
  const jobDir = path.join(OUTPUT_DIR, job.id);
  await fs.mkdir(jobDir, { recursive: true });

  const session = await service.createSession({
    url: job.url,
    skipSplash: false,
    captureInitialScreenshot: true,
  });

  const report = {
    id: job.id,
    url: job.url,
    metadata: job.metadata,
    viewport: config.viewport,
    deviceScaleFactor: 1,
    sessionId: session.id,
    openedAt: new Date().toISOString(),
    steps: [],
  };

  try {
    const initialPath = await copyScreenshot(session.screenshot, jobDir, '000-initial.png');
    report.initial = {
      screenshot: initialPath,
      network_marker: session.network?.marker ?? null,
    };

    for (let index = 0; index < job.steps.length; index += 1) {
      const step = job.steps[index];
      const prefix = String(index + 1).padStart(3, '0');

      if (step.type === 'wait') {
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        const shot = await service.capture(session.id, step.label);
        const copied = await copyScreenshot(shot, jobDir, `${prefix}-${step.label}.png`);
        report.steps.push({ index, ...step, screenshot: copied });
        continue;
      }

      if (step.type === 'capture') {
        const shot = await service.capture(session.id, step.label);
        const copied = await copyScreenshot(shot, jobDir, `${prefix}-${step.label}.png`);
        report.steps.push({ index, ...step, screenshot: copied });
        continue;
      }

      const result = await service.click(session.id, {
        x: step.x,
        y: step.y,
        button: step.button,
        clickCount: step.clickCount,
        observeMs: step.observeMs,
        settleTimeoutMs: step.settleTimeoutMs,
        captureScreenshot: true,
      });
      if (step.waitAfterMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, step.waitAfterMs));
        result.screenshot = await service.capture(session.id, `${step.label}-after-wait`);
      }
      const copied = await copyScreenshot(
        result.screenshot,
        jobDir,
        `${prefix}-${step.label}.png`,
      );

      const slice = {
        marker_before: result.networkMarkerBefore,
        marker_after: result.networkMarkerAfter,
        activity: result.activity,
        quiet: result.quiet,
        events: economicEvents(result.events),
      };
      const sliceFile = path.join(jobDir, `${prefix}-${step.label}-network.json`);
      await fs.writeFile(sliceFile, JSON.stringify(slice, null, 2), 'utf8');

      report.steps.push({
        index,
        ...step,
        screenshot: copied,
        network: path.relative(process.cwd(), sliceFile),
        request_count: result.requests.length,
        response_count: result.responses.length,
      });
    }

    report.finalNetwork = service.getNetwork(session.id, 0);
    await fs.writeFile(
      path.join(jobDir, 'network-full.json'),
      JSON.stringify(report.finalNetwork, null, 2),
      'utf8',
    );
    report.completedAt = new Date().toISOString();
    report.ok = true;
    return report;
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
    report.completedAt = new Date().toISOString();
    return report;
  } finally {
    await service.closeSession(session.id);
    await fs.writeFile(path.join(jobDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  }
}

const raw = JSON.parse(await fs.readFile(PLAN_FILE, 'utf8'));
const plan = validatePlan(raw);
await fs.mkdir(OUTPUT_DIR, { recursive: true });

const service = new BrowserService(config);
await service.start();

try {
  const reports = [];
  for (const job of plan.jobs) {
    reports.push(await runJob(service, job));
  }
  const manifest = {
    version: 1,
    plan_file: path.relative(process.cwd(), PLAN_FILE),
    generated_at: new Date().toISOString(),
    viewport: config.viewport,
    jobs: reports,
  };
  await fs.writeFile(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(JSON.stringify({
    jobs: reports.length,
    ok: reports.filter((r) => r.ok).length,
    failed: reports.filter((r) => !r.ok).length,
  }));
} finally {
  await service.stop();
}
