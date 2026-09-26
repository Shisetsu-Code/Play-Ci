import fs from 'node:fs/promises';
import path from 'node:path';
import { threeOaksEffectiveBets } from '../src/providers/three-oaks.js';

const inputRoot = path.resolve(process.argv[2] || 'merged-input');
const outputDir = path.resolve(process.argv[3] || 'artifacts/exhaustive-final');

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

function keyForValidation(v) {
  const mode = v.mode == null ? 'null' : String(v.mode);
  return `${v.url}|${v.kind}|${mode}`;
}

function featureKey(url, f) {
  const mode = f.mode == null ? 'null' : String(f.mode);
  return `${url}|${f.kind}|${mode}`;
}

function csvCell(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `"${String(text ?? '').replaceAll('"', '""')}"`;
}

const files = (await walk(inputRoot)).filter((file) => file.endsWith('analysis-report.json'));
if (!files.length) throw new Error(`No analysis-report.json files found under ${inputRoot}`);

const reports = [];
for (const file of files) {
  reports.push(JSON.parse(await fs.readFile(file, 'utf8')));
}

const targetMap = new Map();
const validationMap = new Map();

for (const report of reports) {
  for (const target of report.targets || []) targetMap.set(target.url, target);
  for (const validation of report.validations || []) validationMap.set(keyForValidation(validation), validation);
}

const targets = [...targetMap.values()].sort((a, b) => a.url.localeCompare(b.url));
const validations = [...validationMap.values()].sort((a, b) => keyForValidation(a).localeCompare(keyForValidation(b)));

const catalog = targets.map((target) => {
  const protocol = target.protocol || {};
  const features = target.declared_features || [];
  const effective = target.provider === '3oaks'
    ? threeOaksEffectiveBets(protocol)
    : { display_bets: [], by_factor: [] };
  const featureValidation = features.map((feature) => {
    const validation = validationMap.get(featureKey(target.url, feature)) || null;
    return {
      ...feature,
      runtime_status: validation?.status || 'NOT_ATTEMPTED',
      runtime_ok: validation?.ok === true,
      runtime_http_status: validation?.response?.http_status ?? null,
      runtime_request: validation?.request ?? null,
    };
  });

  const runtimeAcceptedStatuses = new Set([
    'VALIDATED_NATIVE',
    'VALIDATED_VISUAL',
    'VALIDATED_REQUEST_RECOGNIZED',
    'VALIDATED_PROTOCOL_REPLAY',
    'VALIDATED_REPLAY_RECOGNIZED',
  ]);
  const attemptedFeatures = featureValidation.filter((f) => f.runtime_status !== 'NOT_ATTEMPTED');
  const allAttemptedValidated =
    attemptedFeatures.length > 0 &&
    attemptedFeatures.every((f) => runtimeAcceptedStatuses.has(f.runtime_status));

  return {
    game: (() => {
      try {
        return new URL(target.url).pathname.match(/\/games\/([^/]+)\//)?.[1] || target.url;
      } catch {
        return target.url;
      }
    })(),
    url: target.url,
    provider: target.provider || 'unknown',
    client_family: target.client_family || 'unknown',
    discovery_status: target.status || 'UNKNOWN',
    review_reasons: target.review_reasons || [],
    actions: protocol.actions || [],
    raw_bets: protocol.bets || [],
    bet_factor: protocol.bet_factor ?? null,
    lines: protocol.lines || [],
    denominator: protocol.denominator ?? null,
    display_bets: effective.display_bets || [],
    bets_by_factor: effective.by_factor || [],
    buy_mode_encoding: protocol.buy_mode_encoding ?? null,
    fixed_buy_multiplier: protocol.fixed_buy_multiplier ?? null,
    buy_modes: featureValidation.filter((f) => f.kind === 'buy'),
    boosters: featureValidation.filter((f) => f.kind === 'booster'),
    catalog_status:
      target.status === 'DISCOVERED'
        ? 'COMPLETE'
        : 'REQUIRES_REVIEW',
    runtime_validation_status:
      featureValidation.length === 0
        ? 'NOT_REQUIRED'
        : attemptedFeatures.length === 0
          ? 'NOT_ATTEMPTED'
          : allAttemptedValidated && attemptedFeatures.length === featureValidation.length
            ? 'COMPLETE'
            : 'PARTIAL',
  };
});

const statusCounts = Object.fromEntries(
  [...new Set(validations.map((v) => v.status))].sort().map((status) => [
    status,
    validations.filter((v) => v.status === status).length,
  ])
);

const summary = {
  shards: reports.length,
  targets: targets.length,
  discovered: targets.filter((t) => t.status === 'DISCOVERED').length,
  requires_review: targets.filter((t) => t.status === 'REQUIRES_REVIEW').length,
  declared_features: targets.reduce((sum, t) => sum + (t.declared_features || []).length, 0),
  runtime_validations: validations.length,
  runtime_validated: validations.filter((v) =>
    ['VALIDATED_NATIVE', 'VALIDATED_VISUAL', 'VALIDATED_REQUEST_RECOGNIZED'].includes(v.status)
  ).length,
  runtime_status_counts: statusCounts,
  catalog_complete: catalog.filter((c) => c.catalog_status === 'COMPLETE').length,
  runtime_complete: catalog.filter((c) => c.runtime_validation_status === 'COMPLETE').length,
  runtime_partial: catalog.filter((c) => c.runtime_validation_status === 'PARTIAL').length,
  runtime_not_attempted: catalog.filter((c) => c.runtime_validation_status === 'NOT_ATTEMPTED').length,
  catalog_requires_review: catalog.filter((c) => c.catalog_status === 'REQUIRES_REVIEW').length,
};

const merged = {
  generated_at: new Date().toISOString(),
  summary,
  targets,
  validations,
  catalog,
};

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, 'exhaustive-report.json'), JSON.stringify(merged, null, 2), 'utf8');
await fs.writeFile(path.join(outputDir, 'bet-catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');

const columns = [
  'game','url','provider','client_family','catalog_status','runtime_validation_status','discovery_status',
  'actions','raw_bets','bet_factor','lines','denominator','display_bets',
  'buy_mode_encoding','fixed_buy_multiplier','buy_modes','boosters','review_reasons'
];
const csv = [
  columns.map(csvCell).join(','),
  ...catalog.map((row) => columns.map((col) => csvCell(row[col])).join(',')),
].join('\n') + '\n';
await fs.writeFile(path.join(outputDir, 'bet-catalog.csv'), csv, 'utf8');

const md = [
  '# 3 Oaks exhaustive validation',
  '',
  `Generated: ${merged.generated_at}`,
  `Shards: ${summary.shards}`,
  `Targets: ${summary.targets}`,
  `Discovered: ${summary.discovered}`,
  `Requires review: ${summary.requires_review}`,
  `Declared special modes: ${summary.declared_features}`,
  `Runtime validations: ${summary.runtime_validations}`,
  `Runtime validated: ${summary.runtime_validated}`,
  `Catalog complete: ${summary.catalog_complete}`,
  `Runtime complete: ${summary.runtime_complete}`,
  `Runtime partial: ${summary.runtime_partial}`,
  `Runtime not attempted: ${summary.runtime_not_attempted}`,
  `Catalog requires review: ${summary.catalog_requires_review}`,
  '',
  'Runtime statuses:',
  ...Object.entries(statusCounts).map(([k, v]) => `- ${k}: ${v}`),
  '',
].join('\n');
await fs.writeFile(path.join(outputDir, 'summary.md'), md, 'utf8');

const unfinished = catalog.filter((c) => c.catalog_status !== 'COMPLETE').map((c) => c.url);
await fs.writeFile(path.join(outputDir, 'unfinished-targets.txt'), unfinished.length ? unfinished.join('\n') + '\n' : '', 'utf8');

console.log(JSON.stringify(summary));
