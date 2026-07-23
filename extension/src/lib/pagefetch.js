// Fetch FROM the target site's own page context (a tab on the site) instead of from an
// extension page. This is the core of the "in-session" thesis: a request made inside the site's
// tab inherits the user's full session — cookies, cf_clearance, and the browser's TLS/header
// fingerprint — so Cloudflare/Akamai let it through. A fetch from a chrome-extension:// page looks
// different and gets challenged (HTTP 403 "Just a moment…").
import { chrome } from './ext.js';

// Returns a fetch-like function bound to a tab, yielding a minimal Response ({ ok, status, text,
// json, blob }). Binary bodies (PDFs) are marshalled as base64 across the executeScript boundary.
// A page-context WebSocket lister. Some services (Trade Republic) expose transactions ONLY over a WS API
// (wss://…): the SPA opens a socket, sends `connect <ver> {…}`, subscribes with `sub <id> {type,…}`, and the
// server streams back `<id> A {payload}` frames ending in `<id> C`. Run entirely in the site's tab (via
// executeScript) so the session cookie + anti-bot token ride the handshake — no token replay needed.
// Phase 1 paginates the list (follow the `after` cursor). Phase 2 (optional `cfg.detail`) then subscribes
// per item for its detail (Trade Republic's timelineDetailV2 — the asset, quantity × price, fees, docs)
// and attaches it to the item, so the mapped record carries the full detail. Returns the flat items array.
export function makePageWs(tabId) {
  return async (cfg) => {
    let out;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', args: [cfg],
        func: (c) => new Promise((resolve) => {
          const get = (o, p) => (p ? String(p).split('.').reduce((x, k) => (x == null ? x : x[k]), o) : o);
          const items = []; let subId = 1, connected = false, done = false;
          const pending = new Map(); // subId → callback(dataObj)
          let ws; try { ws = new WebSocket(c.url); } catch (e) { return resolve({ items: [], error: String(e) }); }
          const finish = (extra) => { if (done) return; done = true; clearTimeout(to); try { ws.close(); } catch (e) {} resolve({ items, ...(extra || {}) }); };
          const to = setTimeout(() => finish({ timeout: true }), c.timeoutMs || 60000);
          const isHeartbeat = (d) => d && typeof d === 'object' && ('status' in d) && !('items' in d) && !('sections' in d) && !('cursors' in d);
          const send = (payload, cb) => { const id = ++subId; pending.set(id, cb); try { ws.send('sub ' + id + ' ' + JSON.stringify(payload)); } catch (e) { finish({ error: 'send' }); } };
          ws.onopen = () => { try { ws.send('connect ' + (c.connectVersion || 31) + ' ' + JSON.stringify(c.connect || {})); } catch (e) { finish({ error: 'send connect' }); } };
          ws.onmessage = (ev) => {
            const s = String(ev.data);
            if (!connected) { connected = true; timelinePage(); return; } // first frame after connect = "connected" ack
            const m = s.match(/^(\d+) ([A-Z])(?: ([\s\S]*))?$/);
            if (!m) return;
            const id = +m[1], code = m[2], body = m[3];
            if (code === 'A' && body) {
              let d; try { d = JSON.parse(body); } catch (e) { return; }
              if (isHeartbeat(d)) return;              // subscription-active heartbeat, keep waiting for data
              const cb = pending.get(id); if (!cb) return;
              pending.delete(id); try { ws.send('unsub ' + id); } catch (e) {}
              cb(d);
            } else if (code === 'E') { const cb = pending.get(id); pending.delete(id); if (cb) cb(null); }
          };
          ws.onerror = () => finish({ error: 'ws error' });
          ws.onclose = () => finish({ closed: true });
          // Phase 1: paginate the list by the `after` cursor.
          let pages = 0;
          const timelinePage = (after) => send({ type: c.sub.type, ...(c.sub.extra || {}), ...(after ? { [c.cursorParam || 'after']: after } : {}) }, (d) => {
            if (!d) return finish({ error: 'sub failed' });
            for (const it of (get(d, c.itemsPath) || [])) items.push(it);
            const next = c.cursorPath ? get(d, c.cursorPath) : null;
            if (next && ++pages < (c.maxPages || 100)) timelinePage(next);
            else phase2();
          });
          // Phase 2: enrich each item with its detail subscription (optional).
          const phase2 = () => {
            if (!c.detail || !items.length) return finish();
            let i = 0;
            const nextDetail = () => {
              if (i >= items.length || i >= (c.detail.max || 2000)) return finish();
              const it = items[i++];
              const detId = get(it, c.detail.idField || 'id');
              if (detId == null || detId === '') return nextDetail();
              send({ type: c.detail.subType, [c.detail.idParam || 'id']: detId }, (d) => { if (d) it[c.detail.attachAs || 'detail'] = d; nextDetail(); });
            };
            nextDetail();
          };
        }),
      });
      out = res && res.result;
    } catch (e) { out = { items: [], error: String((e && e.message) || e) }; }
    return out || { items: [] };
  };
}

// A page-context mtop lister (Alibaba's gateway — AliExpress/Taobao/Tmall/Lazada/1688…). mtop requests are
// signed (`sign` from the `_m_h5_tk` cookie) — anti-bot. Instead of replaying/forging the signature or the
// framework payload, we run in the site tab (MAIN world) and reuse the PAGE's own machinery: hook.js has
// stashed the SPA's live request body on `window.__habeas_mtop[api]`, and the page's `lib.mtop.request`
// re-signs each call. Pagination bumps a page field inside the (stringified) payload. Returns each page's
// raw response; the runtime extracts items (itemsFromKeys) from them.
export function makePageMtop(tabId) {
  return async (cfg) => {
    let out;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', args: [cfg],
        func: async (c) => {
          // dotted get with a trailing-`*` wildcard segment (component keys like pc_om_list_body_109702).
          const wildKey = (obj, seg) => seg.endsWith('*') ? Object.keys(obj || {}).find((k) => k.startsWith(seg.slice(0, -1))) : seg;
          const get = (o, p) => { let c2 = o; for (const s of String(p).split('.')) { if (c2 == null) return undefined; c2 = c2[wildKey(c2, s)]; } return c2; };
          // Deep-set through STRINGIFIED-JSON layers: a segment ending in `~` means that key's value is a
          // JSON string (parse before descending, re-stringify on unwind). mtop/DIDA nests the page field
          // several strings deep: payload.params (string) → .data (string) → pc_om_list_body_*.fields.pageIndex.
          // Returns true iff the page field was found & set (a paginable seed); false for a flat/init seed.
          const setDeep = (node, segs, v) => {
            if (node == null || !segs.length) return false;
            let seg = segs[0]; const str = seg.endsWith('~'); if (str) seg = seg.slice(0, -1);
            const k = wildKey(node, seg); if (k == null) return false;
            if (segs.length === 1) { node[k] = v; return true; }
            let child = node[k]; const parse = str && typeof child === 'string';
            if (parse) { try { child = JSON.parse(child); } catch (e) { return false; } }
            const ok = setDeep(child, segs.slice(1), v);
            if (parse && ok) node[k] = JSON.stringify(child);
            return ok;
          };
          // Automate the seed: run in the source tab and provoke the SPA to fetch, instead of asking the
          // user to scroll. hook.js stashes the app's own signed request (POST pager body preferred; the
          // init GET query as a single-page fallback). We nudge the page (scroll to the sentinel + click any
          // "load more") until that stash appears — the app does the fetch + signing, we never forge one.
          const scrollers = () => {
            const out = [document.scrollingElement || document.documentElement]; let n = 0;
            try { for (const el of document.querySelectorAll('div,main,section,ul')) { if (n >= 3) break; if (el.scrollHeight > el.clientHeight + 300 && el.clientHeight > 300) { out.push(el); n++; } } } catch (e) {}
            return out;
          };
          const loadMoreRe = /ver m[aá]s|cargar m[aá]s|load more|show more|see more|more orders/i;
          let dir = 1;
          const nudge = () => { try {
            for (const el of scrollers()) { const max = el.scrollHeight - el.clientHeight; el.scrollTop = dir > 0 ? max : Math.max(0, max - el.clientHeight); }
            window.scrollTo(0, dir > 0 ? document.documentElement.scrollHeight : 0);
            window.dispatchEvent(new Event('scroll')); dir = -dir;
            for (const b of document.querySelectorAll('button,a,[role=button]')) { if (b.offsetParent !== null && loadMoreRe.test((b.textContent || '').trim())) { b.click(); break; } }
          } catch (e) {} };
          const key = String(c.api).toLowerCase();
          const mtop = (window.lib && window.lib.mtop) || window.mtop;
          if (!mtop || !mtop.request) return { pages: [], error: 'mtop lib not found on the page' };
          let payload;
          if (c.data && typeof c.data === 'object') {
            // Explicit payload (a detail call, e.g. a receipt) — no seed/scroll needed. Resolve in-session
            // directives so the call is GLOBAL (locale from the user's own session, not hardcoded):
            //   @seed:FIELD → a top-level field of any stashed request payload (the app's own shipToCountry/
            //                 _lang, whatever the account is); @tz → the browser's GMT±HHMM offset.
            // Unresolved directives are dropped so the server falls back to the account default.
            const resolveDirective = (d) => {
              try {
                if (d === '@tz') { const o = -new Date().getTimezoneOffset(), s = o >= 0 ? '+' : '-', a = Math.abs(o); return 'GMT' + s + String(Math.floor(a / 60)).padStart(2, '0') + String(a % 60).padStart(2, '0'); }
                const m = /^@seed:(.+)$/.exec(d);
                if (m) { const store = window.__habeas_mtop || {}; for (const key of Object.keys(store)) { if (key.indexOf('post:') === 0) continue; let pl; try { pl = JSON.parse(new URLSearchParams(store[key]).get('data')); } catch (e) { continue; } if (pl && pl[m[1]] != null) return pl[m[1]]; } return ''; }
                return d;
              } catch (e) { return ''; }
            };
            payload = {};
            for (const k of Object.keys(c.data)) { let v = c.data[k]; if (typeof v === 'string' && v[0] === '@') v = resolveDirective(v); if (v != null && v !== '') payload[k] = v; }
          } else {
            const t0 = Date.now(); let raw = null;
            while (Date.now() - t0 < (c.seedTimeoutMs || 20000)) {
              raw = window.__habeas_mtop && window.__habeas_mtop[key];
              if (raw) break;
              nudge();
              await new Promise((r) => setTimeout(r, 400));
            }
            if (!raw) return { pages: [], error: 'no seed request captured — open the orders page (the app must fetch at least once)' };
            try { payload = JSON.parse(new URLSearchParams(raw).get('data')); } catch (e) { return { pages: [], error: 'seed payload parse failed' }; }
          }
          // The page field lives several stringified layers deep (c.pagePath uses `~` to mark each one).
          const bump = (n) => { try { return setDeep(payload, String(c.pagePath).split('.'), n); } catch (e) { return false; } };
          // mtop rejects with its response object ({ret:['FAIL_…'], …}) — surface the ret code, not [object Object].
          const errStr = (e) => { if (typeof e === 'string') return e; if (e && e.ret) return [].concat(e.ret).join(','); if (e && e.message) return e.message; try { return JSON.stringify(e).slice(0, 300); } catch (_) { return String(e); } };
          const pages = [];
          let page = c.startPage || 1;
          for (let i = 0; i < (c.maxPages || 100); i++) {
            const bumped = c.pagePath ? bump(page) : false; // false = flat/init seed → one page only
            // lib-mtop derives its transport from `type`+`dataType`: type:'post' → postJSON, and the H5/XHR
            // path needs H5Request:true. (An input type of 'originaljson' matches neither get nor post and
            // throws UNEXCEPT_REQUEST — that value is the SERIALIZED query type, not a valid input.)
            let resp; try { resp = await mtop.request({ api: c.api, v: c.v || '1.0', data: payload, H5Request: true, type: 'post', dataType: 'originaljson', ecode: 1, ...(c.request || {}) }); } catch (e) { if (!pages.length) return { pages: [], error: 'mtop.request rejected: ' + errStr(e) }; break; }
            pages.push(resp);
            const more = c.morePath ? String(get(resp, c.morePath)) === 'true' : false;
            if (!bumped || !more) break;
            page++;
          }
          return { pages };
        },
      });
      out = res && res.result;
    } catch (e) { out = { pages: [], error: String((e && e.message) || e) }; }
    return out || { pages: [] };
  };
}

export function makePageFetch(tabId, adapter) {
  // Some SPAs (WSO2/Akamai-fronted, e.g. FECI) keep the bearer in the page's localStorage and rotate it, so
  // CAPTURING it from a seen request is fragile (missing after a browser restart, or if we list before the
  // SPA made an authed call). `auth.tokenFromStorage {key,field,scheme,header}` reads it FRESH from localStorage
  // in the page on every request — the reliable path. Read here (background can't see the page's localStorage).
  const tfs = adapter && adapter.auth && adapter.auth.tokenFromStorage;
  let fronted = false; // a 401 → surface the source tab ONCE per fetcher (not on every request of the op)
  const pf = async (url, init = {}) => {
    const arg = {
      url: String(url),
      method: (init.method || 'GET'),
      headers: init.headers || {},
      body: typeof init.body === 'string' ? init.body : null,
      wantBlob: !!init.wantBlob,
      referrer: init.referrer || null, // set from the tab (same-origin) — the reliable way to spoof Referer
      credentials: init.credentials || 'include', // honor a source's cookie opt-out (auth.cookies:false → 'omit')
      tfs: tfs && tfs.key ? { key: String(tfs.key), field: tfs.field ? String(tfs.field) : '', scheme: tfs.scheme || '', header: (tfs.header || 'authorization').toLowerCase() } : null,
    };
    let out;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [arg],
        func: async (o) => {
          try {
            const headers = { ...(o.headers || {}) };
            if (o.tfs) {
              try {
                const raw = localStorage.getItem(o.tfs.key);
                let val = raw;
                if (raw != null) {
                  let obj = null; try { obj = JSON.parse(raw); } catch (e) {}
                  if (obj && typeof obj === 'object') {
                    if (o.tfs.field) { val = o.tfs.field.split('.').reduce((x, k) => (x == null ? x : x[k]), obj); }
                    else {
                      // Auto-detect the ACCESS token inside a stored token object ({access_token, refresh_token,
                      // id_token, …} or keycloak-js {token, refreshToken, idToken}) — require a real JWT and skip
                      // id/refresh tokens, so we never send the wrong one (FECI's mistake was a non-JWT field).
                      const isJwt = (v) => typeof v === 'string' && v.indexOf('eyJ') === 0;
                      val = undefined;
                      for (const k of ['access_token', 'accessToken', 'token']) { if (isJwt(obj[k])) { val = obj[k]; break; } }
                      if (!val) for (const [k, v] of Object.entries(obj)) { if (isJwt(v) && !/refresh|id[_-]?token|idtoken/i.test(k)) { val = v; break; } }
                    }
                  }
                }
                if (val) headers[o.tfs.header] = (o.tfs.scheme ? o.tfs.scheme + ' ' : '') + val; // fresh token wins over any captured one
              } catch (e) {}
            }
            const r = await fetch(o.url, { method: o.method, headers, body: o.body || undefined, credentials: o.credentials || 'include', ...(o.referrer ? { referrer: o.referrer, referrerPolicy: 'unsafe-url' } : {}) });
            const d = { ok: r.ok, status: r.status, contentType: r.headers.get('content-type') || '', sentHeaders: Object.keys(headers) }; // real headers (incl. a tokenFromStorage-injected one) for accurate diagnostics
            // Decode the SENT bearer's claims (exp / iss / aud only — NEVER the raw token) so a failed auth
            // request can say in the diagnostic whether the token was expired or fresh, without DevTools.
            try {
              const ak = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
              const m = ak && String(headers[ak]).match(/eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\./);
              if (m) { const b = m[1].replace(/-/g, '+').replace(/_/g, '/'); const p = JSON.parse(atob(b + '==='.slice((b.length + 3) % 4))); d.sentToken = { exp: p.exp, iss: p.iss, aud: p.aud, now: Math.floor(Date.now() / 1000) }; }
            } catch (e) {}
            if (o.wantBlob) {
              const bytes = new Uint8Array(await r.arrayBuffer());
              let s = ''; const chunk = 0x8000;
              for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
              d.b64 = btoa(s);
            } else { d.text = await r.text(); }
            return d;
          } catch (e) { return { ok: false, status: 0, error: String(e && e.message || e) }; }
        },
      });
      out = res && res.result;
    } catch (e) { out = { ok: false, status: 0, error: String(e && e.message || e) }; }
    out = out || { ok: false, status: 0, error: 'no result' };
    // A 401 means the session/token isn't usable (the SPA hasn't minted its CSRF token yet, or the session
    // expired) — bring the source's tab to the FRONT so the user sees it and can log in / let the SPA re-auth.
    if (out.status === 401 && !fronted) { fronted = true; foregroundTab(tabId); }
    return {
      ok: out.ok, status: out.status, sentHeaders: out.sentHeaders, sentToken: out.sentToken,
      text: async () => out.text || out.error || '',
      json: async () => JSON.parse(out.text || 'null'),
      blob: async () => {
        const bin = atob(out.b64 || '');
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: out.contentType || 'application/octet-stream' });
      },
    };
  };
  pf.ws = makePageWs(tabId); // WebSocket-API sources (Trade Republic) list through this same tab
  pf.mtop = makePageMtop(tabId); // Alibaba mtop-API sources (AliExpress…) list through this same tab
  return pf;
}

// Bring a tab (and its window) to the foreground — used to surface a source's tab on a 401 so the user can act.
async function foregroundTab(tabId) {
  try { const tab = await chrome.tabs.update(tabId, { active: true }); if (tab && tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
}

// Find an open tab on the source's site and return a page-bound fetch (or null if none is open —
// the caller then falls back to a direct extension fetch, which works for non-anti-bot APIs).
export async function resolveSiteFetch(adapter, ds) {
  const tab = await findSiteTab(adapter, ds);
  if (!tab) return null;
  const pf = makePageFetch(tab.id, adapter);
  try { pf.origin = new URL(tab.url).origin; } catch (e) {} // the domain this session is on — for brand (multi-TLD) sources
  return pf;
}

// For a brand (multi-TLD) source, resolve api.host. A datasource pinned to a country (an INSTANCE — ds.brandDomain)
// ALWAYS uses that country: its store, ledger and session are that country's, so the tab must not override it.
// An UNPINNED source follows the domain of the tab the user is on (the in-page fetch runs in THAT tab, so cookies
// match). A single-domain source is returned unchanged.
export function withBrandHost(adapter, net, ds) {
  if (!adapter || !Array.isArray(adapter.domains) || !adapter.domains.length) return adapter;
  const pinned = ds && ds.brandDomain && adapter.domains.includes(ds.brandDomain) ? 'https://www.' + ds.brandDomain : null;
  const host = pinned || (net && net.origin) || null;
  return host ? { ...adapter, api: { ...adapter.api, host } } : adapter;
}

// The open browser tab (if any) sitting on the source's site — the in-session context to fetch through. For a
// pinned brand INSTANCE, only a tab on THAT country counts (an amazon.es tab must not serve the amazon.com
// instance — it would write .es data into the .com store).
export async function findSiteTab(adapter, ds) {
  const pinned = ds && ds.brandDomain && Array.isArray(adapter.domains) && adapter.domains.includes(ds.brandDomain) ? ds.brandDomain : null;
  const pats = [];
  if (pinned) { pats.push(`*://*.${pinned}/*`, `*://${pinned}/*`); }
  else {
    if (adapter.domain) pats.push(`*://*.${adapter.domain}/*`, `*://${adapter.domain}/*`);
    for (const d of adapter.domains || []) pats.push(`*://*.${d}/*`, `*://${d}/*`); // brand TLDs (amazon.es/.com/.de…)
    for (const m of adapter.match || []) {
      const h = String(m).replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '');
      if (h && !pats.some((p) => p.endsWith('//' + h + '/*') || p.endsWith('.' + h + '/*'))) pats.push(`*://${h}/*`);
    }
  }
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: pats }); } catch (e) {}
  return tabs.find((t) => t && t.id != null && /^https?:/.test(t.url || '')) || null;
}

// The site's base URL (from the source's match / api host) — where a tab is opened to establish the
// in-session context the page-context fetch needs.
export function siteBaseUrl(adapter, ds) {
  // Brand (multi-TLD) source pinned to a country (ds.brandDomain): open THAT country's site so an unattended
  // scheduled run establishes the right session (otherwise there's no tab to infer the domain from). Honor the
  // source's openUrl PATH (its "my orders" page) on the pinned domain — landing on the root instead of the
  // orders page leaves the SPA/locale context unestablished, which can make the list fetch come back empty
  // (e.g. a Spanish-language amazon.com redirects order pages to /-/es/). Falls back to the root.
  if (Array.isArray(adapter.domains) && adapter.domains.length && ds && ds.brandDomain && adapter.domains.includes(ds.brandDomain)) {
    const base = 'https://www.' + ds.brandDomain;
    if (adapter.openUrl && /^https:\/\//.test(adapter.openUrl)) { try { const u = new URL(adapter.openUrl); return base + u.pathname + u.search; } catch (e) {} }
    return base + '/';
  }
  // A source can name the exact page to open (openUrl) — its "my purchases / account" page — so the tab
  // lands the user on their data AND loads the SPA whose CSP allows the API host. Guarded to the source's
  // own registrable domain by validate.js (collectHosts), like every other host it touches.
  const open = adapter.openUrl;
  if (open && /^https:\/\//.test(open)) return open;
  // Else a source can point the login tab at its actual sign-in page (e.g. WiZink's /login) instead of the
  // site root, so a logged-out user lands where they can authenticate.
  const login = adapter.auth && adapter.auth.loginUrl;
  if (login && /^https:\/\//.test(login)) return login;
  const host = ((adapter.api && adapter.api.host) || '').replace(/^https?:\/\//, '');
  const m = (adapter.match && adapter.match[0]) || ('https://' + host + '/*');
  const base = m.replace(/^([a-z]+:\/\/[^/]+).*/i, '$1');
  return (base || 'https://' + host) + '/';
}

// A page-bound fetch for the source's site. Reuses an open tab; with { open:true }, LAUNCHES one when
// none exists (so the session is available — the user may need to log in there) and waits for it to load.
// This is what makes a source recover from "no tab → CSRF/auth failure" instead of silently failing.
export async function ensureSiteFetch(adapter, { open = false, ds } = {}) {
  const existing = await resolveSiteFetch(adapter, ds);
  if (existing || !open) return existing;
  const url = siteBaseUrl(adapter, ds);
  let tab; try { tab = await chrome.tabs.create({ url, active: true }); } catch (e) { return null; }
  if (!tab || tab.id == null) return null;
  await waitTabComplete(tab.id);
  const pf = makePageFetch(tab.id, adapter);
  try { pf.origin = new URL(tab.url || url).origin; } catch (e) {}
  return pf;
}

const cookieDomain = (adapter) => (adapter.domain || ((adapter.api && adapter.api.host) || '').replace(/^https?:\/\//, '').replace(/[:/].*$/, ''));

// Called when an operation failed for auth reasons (CSRF / 401 / 403 / 500 login). For a resetCookies
// source (WiZink corrupts its own cookies), wipe them and open a FRESH tab so the user gets a clean
// login — this fires even when a stale tab is already open. Returns how many cookies were cleared.
export async function recoverSession(adapter) {
  let cleared = 0;
  if (adapter.auth && adapter.auth.resetCookies) { try { cleared = await clearSiteCookies(cookieDomain(adapter)); } catch (e) {} }
  // Point the site tab at the sign-in page (auth.loginUrl, else the site root) so the user re-logs in —
  // that fresh login is what re-triggers the SPA's auth/context requests (token + e.g. a DNI). Navigating
  // an already-open tab there beats reloading its current URL (which may be a stale/errored data page).
  const url = siteBaseUrl(adapter);
  const tab = await findSiteTab(adapter);
  try {
    if (tab) await chrome.tabs.update(tab.id, { active: true, url });
    else await chrome.tabs.create({ url, active: true });
  } catch (e) {}
  return cleared;
}

// Remove every cookie for a registrable domain (and its subdomains). Needs the `cookies` permission +
// host access for the domain. Used to recover from a site whose corrupted cookies block a fresh login.
export async function clearSiteCookies(domain) {
  if (!(chrome.cookies && domain)) return 0;
  let all = [];
  try { all = await chrome.cookies.getAll({ domain }); } catch (e) { return 0; }
  let n = 0;
  for (const c of all) {
    const url = (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + c.path;
    try { await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId }); n++; } catch (e) {}
  }
  return n;
}
async function waitTabComplete(tabId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let tab; try { tab = await chrome.tabs.get(tabId); } catch (e) { return; }
    if (!tab) return;
    if (tab.status === 'complete') return;
    await new Promise((r) => setTimeout(r, 300));
  }
}
