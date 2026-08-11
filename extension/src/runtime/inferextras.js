// Extra inferences for record mode, drawn from signal the recorder already captures but the drafter
// ignored. Each one covers a field that was previously hand-written after the fact:
//
//   window / maxAgeDays  — 6 sources. ING rejected the month straddling its 90-day boundary because the
//                          adapter asked from the 1st of the month; the SPA's own request showed the
//                          boundary all along.
//   throttle             — 3 sources. Copying the site's own pacing is what keeps a replay looking like
//                          the SPA rather than a script.
//   capturePaths         — 6 sources. A bearer that differs per path is scoped to that path.
//
// Kept out of infer.js so each is separately testable, and so a nulled-out guess is obviously a no-op.
// Every function returns null rather than a shaky guess: a wrong field in a draft is worse than a
// missing one, because the author stops looking once something is filled in.

const DATE_PARAM = /^(from|since|start|desde|begin)|(from|since|start|desde|begin)[_-]?(date|fecha)$|^(date|fecha)[_-]?(from|desde|start)$/i;
const DATE_VALUE = /^(\d{4})-(\d{2})-(\d{2})/;

// Windows a service plausibly enforces. Below this it is the user's own filter; above it, an
// "everything" query rather than a retention limit.
const MIN_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 800;

/**
 * The rolling date window the site itself asked for, as `{ window: '<n>d', maxAgeDays: n }`.
 * Reads the widest span seen — a narrow one is a filter the user clicked, the widest is the limit.
 * Returns null when there is no date parameter or no plausible window.
 */
export function inferWindow(samples, now = Date.now()) {
  let widest = 0;
  for (const s of samples || []) {
    let url;
    try { url = new URL(s.url); } catch (e) { continue; }
    for (const [k, v] of url.searchParams) {
      if (!DATE_PARAM.test(k)) continue;
      const m = DATE_VALUE.exec(String(v));
      if (!m) continue;
      const from = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
      if (Number.isNaN(from)) continue;
      const days = Math.round((now - from) / 86400000);
      if (days >= MIN_WINDOW_DAYS && days <= MAX_WINDOW_DAYS && days > widest) widest = days;
    }
  }
  return widest ? { window: `${widest}d`, maxAgeDays: widest } : null;
}

/**
 * The pacing the site used between its own calls, as `{ minMs, jitterMs }`.
 * Needs `at` timestamps on the samples; without them there is nothing to measure and this returns null.
 * A burst (everything within a few ms) means the site did not pace itself, so neither should we.
 */
export function inferThrottle(samples) {
  const times = (samples || []).map((s) => s.at).filter((t) => typeof t === 'number').sort((a, b) => a - b);
  if (times.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (!(median >= 100)) return null;                    // sub-100ms is a burst, not pacing
  // Sit just under the observed median and jitter around it: an exact fixed interval is itself a tell.
  const minMs = Math.max(100, Math.round(median * 0.9 / 50) * 50);
  return { minMs, jitterMs: Math.max(50, Math.round(minMs * 0.5 / 50) * 50) };
}

// A credential the redactor has already replaced. Guessing a scope from these would produce a wrong
// answer for every shared handoff, since they all look identical after redaction.
const REDACTED = /^\[(cred|token|jwt|v|id#\d+)\]$/i;

/**
 * Path prefixes whose requests carry a *different* bearer from the rest, as `['/dashboard', …]`.
 * A site that mints a token per area needs the capture scoped the same way, or the replay sends the
 * wrong one. Returns null when every request shares one credential, or when they are redacted.
 */
export function inferCapturePaths(samples) {
  const byCred = new Map();
  for (const s of samples || []) {
    const h = s.reqHeaders || {};
    const key = Object.keys(h).find((k) => k.toLowerCase() === 'authorization');
    if (!key) continue;
    const cred = String(h[key] || '').trim();
    if (!cred || REDACTED.test(cred)) continue;
    let path;
    try { path = new URL(s.url).pathname; } catch (e) { continue; }
    if (!byCred.has(cred)) byCred.set(cred, []);
    byCred.get(cred).push(path);
  }
  if (byCred.size < 2) return null;                     // one credential everywhere → no scoping needed

  // For each credential, the longest path prefix shared by all of its requests. That prefix is the scope.
  const scopes = [];
  for (const paths of byCred.values()) {
    const segs = paths.map((p) => p.split('/').filter(Boolean));
    const first = segs[0] || [];
    let common = [];
    for (let i = 0; i < first.length; i++) {
      if (segs.every((s) => s[i] === first[i])) common.push(first[i]); else break;
    }
    if (common.length) scopes.push('/' + common.join('/'));
  }
  // Trailing slash to match the convention in every existing source (`/dashboard/`, `/api/servicing/`).
  // capturePaths is an ALLOWLIST, so the caller keeps only the scope covering the paths it will replay.
  const uniq = [...new Set(scopes)];
  return uniq.length >= 2 ? uniq.map((p) => p + '/') : null;
}
