// Auto-sync scheduling policy — pure, unit-tested. The background worker fires a `mode:auto` route on
// the user's OWN login/navigation (never a background job while they're away). These helpers decide
// WHEN a route may run again, keeping that timing logic out of the side-effectful service worker.

// A route that ran is debounced for this long, so a chatty SPA (many `complete` navigations) doesn't
// re-list on every page. Only a COMPLETED run holds it — see retainAutoDebounce.
export const AUTO_DEBOUNCE_MS = 10 * 60 * 1000;

// After a token/header CAPTURE, wait this long (coalescing the burst of authenticated requests a freshly
// loaded dashboard fires) before launching the auto-run. A capture only happens AFTER login completes (the
// bearer doesn't exist until the SPA's first authenticated call — e.g. FECI's `/dashboard/user`), so this
// settle window keeps auto-run from firing in the middle of a fragile bank login and folds many rapid
// captures into a single run once activity quiets.
export const AUTO_CAPTURE_SETTLE_MS = 6 * 1000;

// May a route run now? `lastAt` is the epoch-ms of its last held run, or null/undefined when it never
// ran (or the debounce was released). Returns true while still inside the debounce window.
export function autoDebounced(lastAt, now, debounceMs = AUTO_DEBOUNCE_MS) {
  return lastAt != null && now - lastAt < debounceMs;
}

// Exponential backoff for a REPEATEDLY-failing auto-run, so a source whose session keeps getting rejected (ING's
// 401 loop) stops hammering. The FIRST failure still retries at once — a premature pre-login failure must not mute
// a source — but each further consecutive failure doubles the cooldown, up to a cap.
export const AUTO_BACKOFF_BASE_MS = 2 * 60 * 1000;   // 2 min after the 2nd consecutive failure
export const AUTO_BACKOFF_CAP_MS = 2 * 60 * 60 * 1000; // capped at 2 h
export function autoBackoffMs(fails) {
  const n = Math.max(0, fails | 0);
  if (n <= 1) return 0; // 1st failure → retry immediately (a real login re-fires it)
  return Math.min(AUTO_BACKOFF_BASE_MS * Math.pow(2, n - 2), AUTO_BACKOFF_CAP_MS);
}

// The bare host of a URL / match pattern / domain (strips scheme, `*.`, port, path). '' when empty.
function hostFrom(s) {
  return String(s || '').replace(/^[a-z]+:\/\//i, '').replace(/^\*\./, '').replace(/[:/?#].*$/, '').toLowerCase();
}
// Must this source's session replay run INSIDE its site's page context (never a direct service-worker fetch)?
// A SW fetch ALWAYS carries the extension's Origin (`chrome-extension://…`, Sec-Fetch-Site: cross-site). An API
// whose host differs from the site's own host sees that as a cross-origin request, and a WAF/edge (Akamai,
// Cloudflare, F5…) rejects it with a bare "401 Authorization Required" — the exact failure ING hit. So a
// cross-origin API is page-only BY DEFAULT (only the page reproduces the SPA's real Origin); a same-host API is
// not. Explicit flags override the heuristic: `auth.pageOnly:true` forces it on, `auth.swFetchOk:true` (a
// verified CORS-open API, e.g. Carrefour's apigee) forces it off so unattended/headless SW fetches keep working.
export function needsPageContext(adapter) {
  const au = (adapter && adapter.auth) || {};
  if (au.pageOnly) return true;
  if (au.swFetchOk) return false;
  const apiHost = hostFrom(adapter && adapter.api && adapter.api.host);
  if (!apiHost) return false;
  const siteHosts = [];
  for (const m of (adapter && adapter.match) || []) siteHosts.push(hostFrom(m));
  if (adapter && adapter.domain) siteHosts.push(hostFrom(adapter.domain));
  for (const d of (adapter && adapter.domains) || []) siteHosts.push(hostFrom(d));
  return siteHosts.length ? !siteHosts.includes(apiHost) : false; // cross-origin (different host) → needs the page
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

// Does `url` match a single ready-view pattern? Same host, path prefix, and — for a hash-routed SPA — the
// declared hash-route prefix (the trailing id/params are ignored).
function readyUrlMatch(url, pattern) {
  try {
    const a = new URL(url), b = new URL(pattern);
    if (a.host !== b.host) return false;
    const p = a.pathname.replace(/\/+$/, ''), q = b.pathname.replace(/\/+$/, '');
    if (!(p === q || p.startsWith(q + '/'))) return false;
    if (b.hash) { // SPA hash route (e.g. #producto/<id>): require the declared prefix, ignore the id
      const ah = a.hash.replace(/^#/, ''), bh = b.hash.replace(/^#/, '');
      return ah === bh || ah.startsWith(bh);
    }
    return true;
  } catch (e) { return false; }
}

// The INVERSE of the login gate. Some SPAs fire authenticated (capturable) requests on EARLY screens too,
// but a source's real data only exists once a specific view has fully loaded. Running auto-sync on those
// early captures asks the API for data before the session/view is ready (ING is "too eager": its movements
// and statements only appear once the PFM product view is open, at …/pfm/#producto/<session-uuid>). When a
// source declares `auth.readyUrl` — a single pattern OR an array of them — hold auto-run until the trigger
// URL matches ANY declared view (same host, path prefix, and for a hash-routed SPA the declared hash-route
// prefix; the trailing id/params are ignored). No readyUrl → every navigation counts as ready (default;
// fully backward-compatible). A declared gate with no visible URL returns false: we can't confirm we're on a
// ready view, so we wait rather than fire early.
export function isReadyNavigation(adapter, url) {
  const ready = adapter && adapter.auth && adapter.auth.readyUrl;
  const patterns = (Array.isArray(ready) ? ready : [ready]).filter(Boolean);
  if (!patterns.length) return true; // no gate → always ready
  if (!url) return false;            // gate declared but URL not visible → not confirmed ready
  return patterns.some((pat) => readyUrlMatch(url, pat));
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

// A `resetCookies` source (WiZink corrupts its own session cookies) can only recover from an AUTH failure by
// WIPING the cookies and forcing a clean re-login — an unattended sweep that merely reopens the tab and
// retries just replays the same bad cookies and fails again. This picks the auth-ish failures where such a
// source should wipe-and-relogin instead of tab-retrying. Anti-bot challenges are deliberately EXCLUDED:
// wiping would drop the anti-bot clearance cookie and make the challenge worse (that path stays a retry).
const COOKIE_RESET_AUTH = /csrf|(^|\D)40[13](\D|$)|unauthor|forbidden|not logged|sign ?in|log ?in|(^|\W)session/i;
export function wantsCookieReset(adapter, res) {
  if (!(adapter && adapter.auth && adapter.auth.resetCookies && res)) return false;
  if (res.status === 'nosession') return true;
  return res.status === 'error' && COOKIE_RESET_AUTH.test(String(res.error || ''));
}

// In a "sync all" sweep each source is first tried UNATTENDED (no tab — an existing tab if any, else a
// direct extension fetch). Should we then open the source's tab and retry in-session? A session/anti-bot
// failure means the direct fetch lacked the live session; opening the tab often succeeds when the session
// is still valid (and lets the user log in when it isn't). A completed run, or a hard config error that a
// tab won't fix, does not escalate.
const AUTHISH = /csrf|(^|\D)40[13](\D|$)|challenge|captcha|datadome|akam|token|sesi|session|login|forbidden|unauthor/i;
export function needsTabEscalation(res) {
  if (!res) return false;
  // 'notab' = a page-only source that had a live session but no open tab → opening the site tab and retrying
  // in-page is exactly the fix (unlike 'nosession', which needs the user to actually log in).
  if (res.status === 'challenged' || res.status === 'nosession' || res.status === 'notab') return true;
  return res.status === 'error' && AUTHISH.test(String(res.error || ''));
}

// The sources the on-demand "Sync all" sweep runs, IN ORDER. A source is included unless it opted out
// (`ds.sweep === false`); order is by `ds.sweepOrder` (a number, lower first), with any source that has no
// order kept AFTER the ordered ones in its existing config position (stable). Pure → unit-tested. Both fields
// live on the datasource, so they ride the existing config sync to other devices for free.
export function orderedSweepSources(datasources) {
  return (datasources || [])
    .filter((d) => d && d.enabled && d.sweep !== false)
    .map((d, i) => ({ d, i, o: Number.isFinite(d.sweepOrder) ? d.sweepOrder : Infinity }))
    .sort((a, b) => (a.o - b.o) || (a.i - b.i))
    .map((x) => x.d);
}

// Which sink a "Sync all" sweep delivers a source to, in priority order: its explicit auto-route sink,
// else the source's remembered favorite, else the global default sink. '' when none resolves (the source
// is then reported as having no destination rather than silently skipped). Lets the sweep cover EVERY
// enabled source, not only ones with an auto route configured.
export function sweepSinkId(dsId, autoBy = {}, favs = {}, defaultSink = '') {
  return (autoBy && autoBy[dsId]) || (favs && favs[dsId]) || defaultSink || '';
}
