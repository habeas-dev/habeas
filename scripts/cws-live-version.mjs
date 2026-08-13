#!/usr/bin/env node
// What the Chrome Web Store is ACTUALLY serving, asked the way Chrome itself asks.
//
// Why this exists: the release workflow reported the store's state from the upload API's return code, and
// that code says nothing about what users receive. A release sat "Published — public" in the dashboard
// while the update service still served the previous version, and a 400 from the publish call read as a
// hard failure when publishing had in fact worked. Both times the state had to be deduced from an error
// code and a screenshot. This reports it instead.
//
// The endpoint is the public update-check service every Chrome install polls; the extension id is in every
// install link, so nothing here is secret and no credentials are involved.
//
//   node scripts/cws-live-version.mjs <extension-id> [expected-version]
//
// Prints the served version, plus a verdict when an expected version is given. Never exits non-zero for a
// store that is merely behind or unreachable: propagation is normal and the update service is not ours.

const ENDPOINT = 'https://clients2.google.com/service/update2/crx';

/** The version the update service is serving, or '' when it does not say (unknown item, error, garbage). */
export function parseLiveVersion(xml) {
  const text = String(xml || '');
  // Read it off the <updatecheck> element specifically: the envelope also carries protocol="2.0", which a
  // looser match would happily return as the extension's version.
  const el = /<updatecheck\b[^>]*>/i.exec(text);
  if (!el) return '';
  const m = /\bversion="([^"]+)"/i.exec(el[0]);
  return m ? m[1] : '';
}

/**
 * How the store compares to the version just built. `ok` is false only for states worth failing on — and
 * none currently are: a store that lags is propagating, and a service that won't answer is not our problem.
 */
export function compareToLive(built, live) {
  if (!live) return { state: 'unknown', ok: true };
  if (live === built) return { state: 'current', ok: true };
  return { state: cmp(live, built) > 0 ? 'ahead' : 'propagating', ok: true };
}

// Numeric, part-by-part: "0.9.9" is older than "0.9.16", which a string comparison gets backwards.
function cmp(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export async function fetchLiveVersion(id) {
  const url = `${ENDPOINT}?response=updatecheck&prodversion=140&acceptformat=crx3&x=${encodeURIComponent('id=' + id + '&uc')}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (habeas release check)' } });
  if (!res.ok) return '';
  return parseLiveVersion(await res.text());
}

const WORD = {
  current: 'the store is serving this version',
  propagating: 'published, still reaching the update servers (normal, minutes to a few hours)',
  ahead: 'the store is AHEAD of this build — an older tag was re-run?',
  unknown: 'the update service did not answer; state unknown',
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, built] = process.argv.slice(2);
  if (!id) { console.error('usage: cws-live-version.mjs <extension-id> [expected-version]'); process.exit(2); }
  let live = '';
  try { live = await fetchLiveVersion(id); } catch (e) { live = ''; }
  if (!built) { console.log(live || '(unknown)'); process.exit(0); }
  const { state } = compareToLive(built, live);
  console.log(`built ${built} · store ${live || '(unknown)'} — ${WORD[state]}`);
}
