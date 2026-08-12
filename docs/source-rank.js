// Order the landing's source preview by what the visitor can actually use.
//
// The preview used to be a random sample of the catalogue. 14 of the 24 published sources are Spain-only,
// so a visitor from anywhere else mostly saw Spanish supermarkets — and the analytics agree: people
// arrive, read for about a minute, and not one has ever clicked through to a store. Showing someone in
// Berlin that Habeas does N26 and Amazon, rather than Carrefour and Dia, is the difference between "not
// for me" and "oh, that one".
//
// PRIVACY: the browser's language and time zone are read locally and used only to sort a list already on
// the page. Nothing is sent anywhere, no country is recorded, and there is no fingerprinting — Umami is
// cookieless and never sees any of this.

// Time zones for the countries the catalogue covers, plus the ones a visitor is most likely to come from.
// Deliberately small: this only has to be right often enough to sort a list, and a wrong guess merely
// shows a slightly less relevant set — never a broken page.
const TZ_COUNTRY = {
  'Europe/Madrid': 'ES', 'Atlantic/Canary': 'ES', 'Europe/Lisbon': 'PT', 'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE', 'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE',
  'Europe/Dublin': 'IE', 'Europe/London': 'GB', 'Europe/Vienna': 'AT', 'Europe/Zurich': 'CH',
  'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO', 'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI',
  'Europe/Warsaw': 'PL', 'Europe/Prague': 'CZ', 'Europe/Athens': 'GR', 'Europe/Bucharest': 'RO',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US',
  'America/Phoenix': 'US', 'America/Toronto': 'CA', 'America/Vancouver': 'CA',
  'America/Mexico_City': 'MX', 'America/Bogota': 'CO', 'America/Lima': 'PE',
  'America/Argentina/Buenos_Aires': 'AR', 'America/Santiago': 'CL', 'America/Sao_Paulo': 'BR',
  'Asia/Kolkata': 'IN', 'Asia/Shanghai': 'CN', 'Asia/Tokyo': 'JP', 'Asia/Singapore': 'SG',
  'Asia/Dubai': 'AE', 'Australia/Sydney': 'AU',
};

/**
 * Where the visitor is, as `{ country, inEurope }` — `country` is '' when nothing says.
 * The locale's region wins when it has one; a bare language ("es" is spoken across the Americas) says
 * nothing about where, so the time zone decides. A browser set to English in Madrid is still Madrid.
 */
export function detectRegion(env) {
  const language = (env && env.language) || '';
  const timeZone = (env && env.timeZone) || '';
  let country = '';

  const m = /^[a-z]{2,3}[-_]([A-Za-z]{2})\b/.exec(String(language));
  if (m) country = m[1].toUpperCase();
  if (!country && timeZone) country = TZ_COUNTRY[timeZone] || '';

  // Europe is worth knowing on its own: two sources are EU-wide, and a country we don't have in the
  // table above still tells us those are more relevant than Spain-only ones.
  const inEurope = /^Europe\//.test(String(timeZone)) || EU_ISH.has(country);
  return { country, inEurope };
}

const EU_ISH = new Set(['ES', 'PT', 'FR', 'DE', 'IT', 'NL', 'BE', 'IE', 'GB', 'AT', 'CH', 'SE', 'NO',
  'DK', 'FI', 'PL', 'CZ', 'GR', 'RO', 'HU', 'BG', 'HR', 'SK', 'SI', 'LT', 'LV', 'EE', 'LU', 'CY', 'MT']);

// Lower is shown first. A source with no declared country is global in practice (PayPal), so it is
// treated as such rather than sunk to the bottom as "unknown".
function tierOf(source, region) {
  const country = String((source && source.country) || 'global');
  if (region.country && country === region.country) return 0; // their own country
  if (country === 'EU' && region.inEurope) return 1;          // EU-wide, and they are in Europe
  if (country === 'global') return 2;                         // works anywhere
  return 3;                                                   // some other country's service
}

/**
 * The same sources, ordered by how likely the visitor is to recognise them. Stable within a tier, so a
 * caller that shuffles first still gets variety on every load without the ordering becoming arbitrary.
 */
export function rankSources(sources, region) {
  const list = Array.isArray(sources) ? sources.slice() : [];
  const where = region || { country: '', inEurope: false };
  return list
    .map((source, i) => ({ source, i, tier: tierOf(source, where) }))
    .sort((a, b) => (a.tier - b.tier) || (a.i - b.i))
    .map((x) => x.source);
}

// The landing loads this as a module; i18n.js is a classic script and picks it up from here. It degrades
// to the old random sample if this file ever fails to load, so the preview can never end up empty.
globalThis.habeasSourceRank = { detectRegion, rankSources };
