import path from 'node:path';

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export const config = Object.freeze({
  host: process.env.HOST || '127.0.0.1',
  port: intEnv('PORT', 31337, { min: 1, max: 65535 }),
  artifactDir: path.resolve(process.env.ARTIFACT_DIR || 'artifacts'),
  viewport: Object.freeze({
    width: intEnv('VIEWPORT_WIDTH', 1280, { min: 320, max: 7680 }),
    height: intEnv('VIEWPORT_HEIGHT', 720, { min: 240, max: 4320 }),
  }),
  navigationTimeoutMs: intEnv('NAVIGATION_TIMEOUT_MS', 45000, { min: 1000, max: 180000 }),
  initialSettleMs: intEnv('INITIAL_SETTLE_MS', 1500, { min: 0, max: 30000 }),
  splashTimeoutMs: intEnv('SPLASH_TIMEOUT_MS', 8000, { min: 0, max: 60000 }),
  clickSettleTimeoutMs: intEnv('CLICK_SETTLE_TIMEOUT_MS', 3500, { min: 250, max: 30000 }),
  quietWindowMs: intEnv('QUIET_WINDOW_MS', 500, { min: 50, max: 10000 }),
  maxBodyBytes: intEnv('MAX_RESPONSE_BODY_BYTES', 2 * 1024 * 1024, { min: 0, max: 50 * 1024 * 1024 }),
  maxMemoryEvents: intEnv('MAX_MEMORY_EVENTS', 10000, { min: 100, max: 100000 }),
  headed: boolEnv('HEADED', false),
  captureSensitiveHeaders: boolEnv('CAPTURE_SENSITIVE_HEADERS', false),
});
