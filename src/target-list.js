export function parseTargetList(text, { maxTargets = 1000 } = {}) {
  const urls = [];
  const seen = new Set();

  for (const [index, rawLine] of String(text ?? '').split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let parsed;
    try {
      parsed = new URL(line);
    } catch {
      throw new Error(`Invalid URL on line ${lineNumber}: ${line}`);
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Unsupported URL protocol on line ${lineNumber}: ${parsed.protocol}`);
    }

    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);

    if (urls.length > maxTargets) {
      throw new Error(`Target list exceeds maximum of ${maxTargets} URLs`);
    }
  }

  return urls;
}
