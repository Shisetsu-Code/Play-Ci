import fs from 'node:fs';
import path from 'node:path';

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
]);

function nowIso() {
  return new Date().toISOString();
}

function redactHeaders(headers, captureSensitiveHeaders) {
  if (captureSensitiveHeaders) return headers;
  return Object.fromEntries(Object.entries(headers || {}).map(([name, value]) => [
    name,
    SENSITIVE_HEADERS.has(name.toLowerCase()) ? '<redacted>' : value,
  ]));
}

function safeFrameUrl(request) {
  try {
    return request.frame()?.url?.() || null;
  } catch {
    return null;
  }
}

function bodyLooksTextual(contentType = '') {
  return /(?:json|text|javascript|xml|x-www-form-urlencoded|graphql|html|svg)/i.test(contentType);
}

export class NetworkRecorder {
  #events = [];
  #seq = 0;
  #requestIds = new WeakMap();
  #requestCounter = 0;
  #stream;
  #lastActivityAt = Date.now();
  #inFlight = 0;
  #closed = false;

  constructor(page, {
    outputFile,
    maxBodyBytes = 2 * 1024 * 1024,
    maxMemoryEvents = 10000,
    captureSensitiveHeaders = false,
  }) {
    this.page = page;
    this.outputFile = outputFile;
    this.maxBodyBytes = maxBodyBytes;
    this.maxMemoryEvents = maxMemoryEvents;
    this.captureSensitiveHeaders = captureSensitiveHeaders;

    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    this.#stream = fs.createWriteStream(outputFile, { flags: 'a', encoding: 'utf8' });
    this.#attach();
  }

  #touch() {
    this.#lastActivityAt = Date.now();
  }

  #idFor(request) {
    let id = this.#requestIds.get(request);
    if (!id) {
      this.#requestCounter += 1;
      id = `req-${this.#requestCounter}`;
      this.#requestIds.set(request, id);
    }
    return id;
  }

  #emit(event) {
    if (this.#closed) return null;
    this.#seq += 1;
    const record = { seq: this.#seq, at: nowIso(), ...event };
    this.#events.push(record);
    if (this.#events.length > this.maxMemoryEvents) {
      this.#events.splice(0, this.#events.length - this.maxMemoryEvents);
    }
    this.#stream.write(`${JSON.stringify(record)}\n`);
    this.#touch();
    return record;
  }

  #attach() {
    this.page.on('request', (request) => {
      this.#inFlight += 1;
      this.#emit({
        type: 'request',
        requestId: this.#idFor(request),
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        isNavigationRequest: request.isNavigationRequest(),
        frameUrl: safeFrameUrl(request),
        headers: redactHeaders(request.headers(), this.captureSensitiveHeaders),
        postData: request.postData() ?? null,
      });
    });

    this.page.on('response', async (response) => {
      const request = response.request();
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      const base = {
        type: 'response',
        requestId: this.#idFor(request),
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
        headers: redactHeaders(headers, this.captureSensitiveHeaders),
      };

      if (this.maxBodyBytes <= 0 || !bodyLooksTextual(contentType)) {
        this.#emit(base);
        return;
      }

      try {
        const body = await response.body();
        if (body.byteLength <= this.maxBodyBytes) {
          this.#emit({ ...base, bodyEncoding: 'utf8', body: body.toString('utf8') });
        } else {
          this.#emit({ ...base, bodyOmitted: 'too_large', bodyBytes: body.byteLength });
        }
      } catch (error) {
        this.#emit({ ...base, bodyOmitted: 'unavailable', bodyError: error.message });
      }
    });

    this.page.on('requestfinished', (request) => {
      this.#inFlight = Math.max(0, this.#inFlight - 1);
      this.#emit({
        type: 'requestfinished',
        requestId: this.#idFor(request),
        url: request.url(),
      });
    });

    this.page.on('requestfailed', (request) => {
      this.#inFlight = Math.max(0, this.#inFlight - 1);
      this.#emit({
        type: 'requestfailed',
        requestId: this.#idFor(request),
        url: request.url(),
        failure: request.failure(),
      });
    });
  }

  marker() {
    return this.#seq;
  }

  eventsAfter(seq = 0) {
    return this.#events.filter((event) => event.seq > seq);
  }

  async waitForQuiet({ quietMs = 500, timeoutMs = 3500 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const quietFor = Date.now() - this.#lastActivityAt;
      if (this.#inFlight === 0 && quietFor >= quietMs) {
        return { quiet: true, waitedMs: Date.now() - started, inFlight: 0 };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, quietMs)));
    }
    return { quiet: false, waitedMs: Date.now() - started, inFlight: this.#inFlight };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await new Promise((resolve) => this.#stream.end(resolve));
  }
}
