export async function readJson(req, { maxBytes = 1024 * 1024 } = {}) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 });
  }
}

export function json(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function errorJson(res, error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  json(res, statusCode, {
    ok: false,
    error: statusCode >= 500 ? 'internal_error' : 'bad_request',
    message: error?.message || 'unknown error',
  });
}
