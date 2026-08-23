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
 * How the store compares to the version just built, as `{ state, stale, ok, note }`.
 *
 * `note` is the part a human reads, so it must never claim more than is known. The previous wording said
 * "published, still reaching the update servers (normal, minutes to a few hours)" for ANY version the
 * store was not yet serving — including one that had never been uploaded, and one that had been stuck for
 * three days. Both were stated as fact and both were false, and the reassurance cost days of looking in
 * the wrong place. So: an upload is never claimed, and a timescale is only mentioned when `ageHours` is
 * actually known.
 *
 * `ok` is false only for states worth failing on, and none are: being behind is not a build failure, and
 * an unreachable update service is not ours to fail on.
 */
/**
 * Hours between two instants, counting only Monday–Friday. Google does not review at the weekend, so a
 * Saturday release that is still unserved on Sunday is not evidence of anything — and saying it is, in
 * the alarming register the stale message uses, trains you to ignore the message.
 *
 * Deliberately whole days rather than office hours: this answers "should I be worried yet", and
 * pretending to know Mountain View's working hours would be false precision.
 */
export function businessHoursBetween(from, to) {
  if (!(to > from)) return 0;
  const DAY = 86400000, HOUR = 3600000;
  let hours = 0;
  // Walk hour by hour: simple, exact at any boundary, and a release is never more than a few hundred
  // iterations old before the answer stops mattering.
  const cap = from + 400 * DAY;
  for (let t = from; t < to && t < cap; t += HOUR) {
    const d = new Date(t).getUTCDay();          // 0 Sun … 6 Sat
    if (d !== 0 && d !== 6) hours += Math.min(1, (to - t) / HOUR);
  }
  return Math.round(hours);
}

export function compareToLive(built, live, ageHours = null, opts = null) {
  if (!live) {
    return { state: 'unknown', stale: false, ok: true,
      note: `built ${built} · the update service did not answer, so what the store serves is unknown` };
  }
  if (live === built) {
    return { state: 'current', stale: false, ok: true,
      note: `built ${built} · the store is serving this version` };
  }
  if (cmp(live, built) > 0) {
    return { state: 'ahead', stale: false, ok: true,
      note: `built ${built} · the store serves ${live}, which is NEWER — was an older tag re-run?` };
  }
  // Prefer the real instants when we have them, so weekends can be discounted; fall back to a plain hour
  // count when only that is available.
  let effHours = ageHours;
  if (opts && typeof opts.releasedAt === 'number') {
    effHours = businessHoursBetween(opts.releasedAt, typeof opts.now === 'number' ? opts.now : Date.now());
  }
  const known = typeof effHours === 'number' && Number.isFinite(effHours);
  const stale = known && effHours >= STALE_AFTER_HOURS;
  let tail;
  if (!known) tail = 'the store has not served it yet';
  else if (stale) tail = `${age(effHours)} of working time since the release and the store still has not served it — `
    + 'this is no longer propagation; check the dashboard for a draft that was never submitted, '
    + 'an unanswered permission justification, or a version still in review';
  else tail = `released ${age(effHours)} of working time ago — still propagating`;
  return { state: 'behind', stale, ok: true, note: `built ${built} · store ${live} · ${tail}` };
}

// A day: long enough that an overnight release is not called stuck, short enough that the three-day
// silence we actually lived through would have been named on the first check of the second day.
const STALE_AFTER_HOURS = 24;
const age = (h) => (h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`);

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, built, releasedAt] = process.argv.slice(2);
  if (!id) { console.error('usage: cws-live-version.mjs <extension-id> [built-version] [release-iso-date]'); process.exit(2); }
  let live = '';
  try { live = await fetchLiveVersion(id); } catch (e) { live = ''; }
  if (!built) { console.log(live || '(unknown)'); process.exit(0); }
  // The age is what turns "still propagating" from a guess into a statement. Without a release date we
  // simply do not say how long it has been.
  // Pass the INSTANT, not a duration: only the instant lets weekends be discounted, and a Saturday
  // release still unserved on Sunday is not evidence of anything.
  let opts = null;
  if (releasedAt) {
    const t = Date.parse(releasedAt);
    if (!Number.isNaN(t)) opts = { releasedAt: t };
  }
  console.log(compareToLive(built, live, null, opts).note);
}
