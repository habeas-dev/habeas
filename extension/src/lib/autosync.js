// Auto-sync scheduling policy — pure, unit-tested. The background worker fires a `mode:auto` route on
// the user's OWN login/navigation (never a background job while they're away). These helpers decide
// WHEN a route may run again, keeping that timing logic out of the side-effectful service worker.

// A route that ran is debounced for this long, so a chatty SPA (many `complete` navigations) doesn't
// re-list on every page. Only a COMPLETED run holds it — see retainAutoDebounce.
export const AUTO_DEBOUNCE_MS = 10 * 60 * 1000;

// May a route run now? `lastAt` is the epoch-ms of its last held run, or null/undefined when it never
// ran (or the debounce was released). Returns true while still inside the debounce window.
export function autoDebounced(lastAt, now, debounceMs = AUTO_DEBOUNCE_MS) {
  return lastAt != null && now - lastAt < debounceMs;
}

// Is this completed navigation the source's own LOGIN page (so the user isn't authenticated yet)? A
// cookie source has no JWT to key a "session ready" trigger on, so the auto-run fires on every completed
// navigation — including the login page, where a session-gated prelude would 400. Skip that one and wait
// for the post-login navigation (e.g. WiZink /login → /clientes/posicion-global). Compares by path
// (segment-aware, ignoring query/hash) against adapter.auth.loginUrl; false when no loginUrl is declared.
export function isLoginNavigation(adapter, url) {
  const login = adapter && adapter.auth && adapter.auth.loginUrl;
  if (!login || !url) return false;
  try {
    const a = new URL(url), b = new URL(login);
    if (a.host !== b.host) return false;
    const p = a.pathname.replace(/\/+$/, ''), q = b.pathname.replace(/\/+$/, '');
    return p === q || p.startsWith(q + '/'); // /login and /login/otp, but not /loginx
  } catch (e) { return false; }
}

// After a run, KEEP the debounce (true) or release it so the next trigger retries immediately (false)?
// A transient/auth failure must release it: the auto-run can fire on the source's login page BEFORE the
// user authenticates (the CSRF prelude then 400s), or hit an anti-bot challenge, or find no captured
// session yet. Holding the debounce in those cases suppresses the retry that the user's real login would
// otherwise trigger — the bug where "it never tries again" after a first, premature failure. Only a
// completed run ('done' — whether it delivered documents or found nothing new) holds the 10-min window.
export function retainAutoDebounce(status) {
  return status === 'done';
}

// In a "sync all" sweep each source is first tried UNATTENDED (no tab — an existing tab if any, else a
// direct extension fetch). Should we then open the source's tab and retry in-session? A session/anti-bot
// failure means the direct fetch lacked the live session; opening the tab often succeeds when the session
// is still valid (and lets the user log in when it isn't). A completed run, or a hard config error that a
// tab won't fix, does not escalate.
const AUTHISH = /csrf|(^|\D)40[13](\D|$)|challenge|captcha|datadome|akam|token|sesi|session|login|forbidden|unauthor/i;
export function needsTabEscalation(res) {
  if (!res) return false;
  if (res.status === 'challenged' || res.status === 'nosession') return true;
  return res.status === 'error' && AUTHISH.test(String(res.error || ''));
}

// Which sink a "Sync all" sweep delivers a source to, in priority order: its explicit auto-route sink,
// else the source's remembered favorite, else the global default sink. '' when none resolves (the source
// is then reported as having no destination rather than silently skipped). Lets the sweep cover EVERY
// enabled source, not only ones with an auto route configured.
export function sweepSinkId(dsId, autoBy = {}, favs = {}, defaultSink = '') {
  return (autoBy && autoBy[dsId]) || (favs && favs[dsId]) || defaultSink || '';
}
