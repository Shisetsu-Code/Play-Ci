import fs from 'node:fs/promises';

export async function loadVisualProfiles(file = 'analysis/visual-profiles.json') {
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  if (raw?.version !== 1 || !Array.isArray(raw.profiles)) {
    throw new Error('visual profiles must be version 1 with a profiles array');
  }
  return raw;
}

export function visualProfileKey({ client_family, buy_count, booster_count }) {
  return `${client_family || 'unknown'}|buy=${Number(buy_count || 0)}|booster=${Number(booster_count || 0)}`;
}

export function indexVisualProfiles(raw) {
  const map = new Map();
  for (const profile of raw.profiles || []) {
    const key = visualProfileKey(profile);
    if (map.has(key)) throw new Error(`duplicate visual profile key: ${key}`);
    map.set(key, profile);
  }
  return map;
}

export function matchVisualProfile(index, discovery) {
  const protocol = discovery?.protocol || {};
  return index.get(visualProfileKey({
    client_family: discovery?.client_family,
    buy_count: (protocol.available_buy_bonus || []).length ||
      ((protocol.actions || []).includes('buy_spin') && Number.isFinite(Number(protocol.fixed_buy_multiplier)) ? 1 : 0),
    booster_count: (protocol.available_booster || []).length,
  })) || null;
}

export function coordinateForBuy(profile, ordinal) {
  return (profile?.buy_options || []).find((entry) => Number(entry.ordinal) === Number(ordinal)) || null;
}

export function coordinateForBooster(profile, ordinal) {
  return (profile?.boosters || []).find((entry) => Number(entry.ordinal) === Number(ordinal)) || null;
}
