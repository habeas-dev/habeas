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

// ---------------------------------------------------------------------------------------------
// currency — 9 sources declare one. It is the FALLBACK used when an item carries no currency of
// its own (sinks/format.js), and until now it defaulted to EUR, which quietly mislabels every
// non-euro source. The captured items say it outright.
// ---------------------------------------------------------------------------------------------
const SYMBOL = [[/€|\bEUR\b/, 'EUR'], [/\$|\bUSD\b/, 'USD'], [/£|\bGBP\b/, 'GBP'], [/\bCHF\b/, 'CHF'],
                [/¥|\bJPY\b/, 'JPY'], [/\bMXN\b/, 'MXN'], [/\bBRL\b/, 'BRL'], [/\bPLN\b/, 'PLN'],
                [/\bSEK\b/, 'SEK'], [/\bNOK\b/, 'NOK'], [/\bDKK\b/, 'DKK'], [/\bCAD\b/, 'CAD'],
                [/\bAUD\b/, 'AUD'], [/\bCNY\b/, 'CNY'], [/\bTRY\b/, 'TRY'], [/\bARS\b/, 'ARS']];
const CODES = new Set(SYMBOL.map(([, c]) => c));
const CUR_KEY = /^(currency|currencycode|divisa|moneda|iso.?currency)$/i;

/**
 * The source's default currency, as an ISO 4217 code, or '' when the items never say.
 * Only a clear majority counts: a genuinely multi-currency list has no single source currency, and
 * declaring one there would relabel every foreign purchase.
 */
export function inferCurrency(items) {
  const votes = new Map();
  const vote = (c) => votes.set(c, (votes.get(c) || 0) + 1);
  for (const it of (items || []).slice(0, 200)) {
    if (!it || typeof it !== 'object') continue;
    let found = false;
    for (const f of flatten(it)) {
      const leaf = f.k.split('.').pop();
      // A field NAMED currency is authoritative — but only if its value is a real code, so a
      // "currency": "default" style value doesn't invent one.
      if (CUR_KEY.test(leaf) && CODES.has(String(f.v).toUpperCase())) { vote(String(f.v).toUpperCase()); found = true; break; }
    }
    if (found) continue;
    // Otherwise a symbol glued to an amount ("19,90 €", "$14.99").
    for (const f of flatten(it)) {
      if (typeof f.v !== 'string') continue;
      if (!/\d/.test(f.v)) continue;                 // a symbol without a number is not an amount
      const hit = SYMBOL.find(([re]) => re.test(f.v));
      if (hit) { vote(hit[1]); break; }
    }
  }
  if (!votes.size) return '';
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((n, [, c]) => n + c, 0);
  return ranked[0][1] / total > 0.6 ? ranked[0][0] : '';
}

function flatten(obj, prefix = '', depth = 2, out = []) {
  for (const k of Object.keys(obj || {})) {
    const v = obj[k], path = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && depth > 0) flatten(v, path, depth - 1, out);
    else out.push({ k: path, v });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// auth.tokenFromStorage — where the SPA keeps the bearer, so the runtime can read it FRESH on every
// request instead of replaying one captured in a session that may since have ended. Without it a
// bearer source stops working after a browser restart. The recording holds both halves: the token
// that was actually sent, and the storage snapshot it came from — so this is a lookup, not a guess.
// ---------------------------------------------------------------------------------------------
const JWTISH = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;

export function inferTokenFromStorage(samples, storage) {
  // The credential as the SPA sent it, plus the header and scheme it used — copied, never assumed.
  let token = '', header = '', scheme = '';
  for (const s of samples || []) {
    for (const [k, raw] of Object.entries(s.reqHeaders || {})) {
      const v = String(raw || '').trim();
      const m = /^(Bearer|Token|JWT)\s+(.+)$/i.exec(v);
      const val = m ? m[2] : v;
      if (!JWTISH.test(val)) continue;               // redacted or opaque → nothing to look up
      token = val; header = k.toLowerCase(); scheme = m ? m[1] : '';
      break;
    }
    if (token) break;
  }
  if (!token) return null;

  // Find that exact value in the storage snapshot. localStorage only: that is what the page-side
  // reader in pagefetch.js can actually read back.
  const bag = (storage && storage.local) || {};
  for (const key of Object.keys(bag)) {
    const raw = bag[key];
    if (raw === token) return { key, field: '', scheme, header };
    let obj = null;
    if (typeof raw === 'string' && (raw[0] === '{' || raw[0] === '[')) { try { obj = JSON.parse(raw); } catch (e) {} }
    else if (raw && typeof raw === 'object') obj = raw;
    if (!obj) continue;
    const field = pathTo(obj, token);
    if (field) return { key, field, scheme, header };
  }
  return null;
}

// The dotted path at which `needle` sits inside `obj`, or '' if it isn't there.
function pathTo(obj, needle, prefix = '', depth = 0) {
  if (depth > 5 || obj == null || typeof obj !== 'object') return '';
  for (const k of Object.keys(obj)) {
    const v = obj[k], path = prefix ? prefix + '.' + k : k;
    if (v === needle) return path;
    if (v && typeof v === 'object') { const sub = pathTo(v, needle, path, depth + 1); if (sub) return sub; }
  }
  return '';
}

// ---------------------------------------------------------------------------------------------
// auth.cookies — whether to send cookies when replaying. Three live sources set it to false: a
// token-authenticated API on its own host, which the SPA calls with no cookies at all. Replaying
// with them is not merely redundant, it sends session cookies the site itself never sent.
// The recorder now captures each request's `credentials`, so this is observed rather than guessed.
// ---------------------------------------------------------------------------------------------

/**
 * `false` when every observed call to `apiHost` went out without cookies, else null (keep the default).
 * `pageHost` matters because fetch defaults to same-origin: a cross-origin call that says nothing about
 * credentials sends none.
 */
export function inferCookies(samples, apiHost, pageHost = '') {
  let seen = 0;
  for (const s of samples || []) {
    let host; try { host = new URL(s.url).host; } catch (e) { continue; }
    if (host !== apiHost) continue;                  // other hosts say nothing about this source
    seen++;
    const cred = s.cred || '';
    if (cred === 'include') return null;             // the SPA wants cookies here
    if (!cred) {
      // Unrecorded: fall back to the browser default, which only sends cookies same-origin.
      if (!pageHost || host === pageHost) return null;
    } else if (cred !== 'omit' && cred !== 'same-origin') return null;
    if (cred === 'same-origin' && host === pageHost) return null;
  }
  return seen ? false : null;
}

// ---------------------------------------------------------------------------------------------
// auth.loginUrl — where to send the user when the session has expired. Without it they land on the
// site root and have to find the sign-in page themselves, mid-sync. They visited it during the
// recording, so the recording knows.
// ---------------------------------------------------------------------------------------------
// Anchored at a path segment, so /blog/inicio is not a login page.
const LOGIN_PATH = /(^|\/)(log[-_]?in|sign[-_]?in|acceso|entrar|iniciar-sesion|autenticacion|auth)(\/|\.|$)/i;

export function inferLoginUrl(pages, pageHost) {
  for (const p of pages || []) {
    const raw = typeof p === 'string' ? p : (p && p.url);
    if (!raw) continue;
    let u; try { u = new URL(raw); } catch (e) { continue; }
    if (u.host !== pageHost) continue;               // an identity provider's page is not this site's
    if (!LOGIN_PATH.test(u.pathname)) continue;
    return u.origin + u.pathname;                    // drop the query: a redirect token is not part of it
  }
  return '';
}
