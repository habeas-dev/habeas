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
// executeScript) so the session cookie + anti-bot token ride the handshake — no token replay needed. The
// whole connect→sub→paginate(after)→collect loop happens in-page and returns the flat items array.
export function makePageWs(tabId) {
  return async (cfg) => {
    let out;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', args: [cfg],
        func: (c) => new Promise((resolve) => {
          const get = (o, p) => (p ? String(p).split('.').reduce((x, k) => (x == null ? x : x[k]), o) : o);
          const all = []; let subId = 1, after = null, pages = 0, connected = false, done = false;
          let ws; try { ws = new WebSocket(c.url); } catch (e) { return resolve({ items: [], error: String(e) }); }
          const finish = (extra) => { if (done) return; done = true; clearTimeout(to); try { ws.close(); } catch (e) {} resolve({ items: all, ...(extra || {}) }); };
          const to = setTimeout(() => finish({ timeout: true }), c.timeoutMs || 25000);
          const sendSub = () => { subId++; const p = { type: c.sub.type, ...(c.sub.extra || {}), ...(after ? { [c.cursorParam || 'after']: after } : {}) }; ws.send('sub ' + subId + ' ' + JSON.stringify(p)); };
          ws.onopen = () => { try { ws.send('connect ' + (c.connectVersion || 31) + ' ' + JSON.stringify(c.connect || {})); } catch (e) { finish({ error: 'send connect' }); } };
          ws.onmessage = (ev) => {
            const s = String(ev.data);
            if (!connected) { connected = true; sendSub(); return; }        // first frame after connect = "connected" ack
            const m = s.match(/^(\d+) ([A-Z])(?: ([\s\S]*))?$/);
            if (!m) return;
            const code = m[2], body = m[3];
            if (code === 'A' && body) {
              let d; try { d = JSON.parse(body); } catch (e) { return; }
              if (d && d.status && get(d, c.itemsPath) == null) return;     // subscription-active heartbeat, not data
              const items = get(d, c.itemsPath) || [];
              for (const it of items) all.push(it);
              try { ws.send('unsub ' + m[1]); } catch (e) {}
              const next = c.cursorPath ? get(d, c.cursorPath) : null;
              pages++;
              if (next && items.length && pages < (c.maxPages || 100)) { after = next; sendSub(); }
              else finish();
            } else if (code === 'E') finish({ error: body });
          };
          ws.onerror = () => finish({ error: 'ws error' });
          ws.onclose = () => finish({ closed: true });
        }),
      });
      out = res && res.result;
    } catch (e) { out = { items: [], error: String((e && e.message) || e) }; }
    return out || { items: [] };
  };
}

export function makePageFetch(tabId) {
  const pf = async (url, init = {}) => {
    const arg = {
      url: String(url),
      method: (init.method || 'GET'),
      headers: init.headers || {},
      body: typeof init.body === 'string' ? init.body : null,
      wantBlob: !!init.wantBlob,
      referrer: init.referrer || null, // set from the tab (same-origin) — the reliable way to spoof Referer
      credentials: init.credentials || 'include', // honor a source's cookie opt-out (auth.cookies:false → 'omit')
    };
    let out;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [arg],
        func: async (o) => {
          try {
            const r = await fetch(o.url, { method: o.method, headers: o.headers, body: o.body || undefined, credentials: o.credentials || 'include', ...(o.referrer ? { referrer: o.referrer, referrerPolicy: 'unsafe-url' } : {}) });
            const d = { ok: r.ok, status: r.status, contentType: r.headers.get('content-type') || '' };
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
    return {
      ok: out.ok, status: out.status,
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
  return pf;
}

// Find an open tab on the source's site and return a page-bound fetch (or null if none is open —
// the caller then falls back to a direct extension fetch, which works for non-anti-bot APIs).
export async function resolveSiteFetch(adapter) {
  const tab = await findSiteTab(adapter);
  return tab ? makePageFetch(tab.id) : null;
}

// The open browser tab (if any) sitting on the source's site — the in-session context to fetch through.
async function findSiteTab(adapter) {
  const pats = [];
  if (adapter.domain) pats.push(`*://*.${adapter.domain}/*`, `*://${adapter.domain}/*`);
  for (const m of adapter.match || []) {
    const h = String(m).replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '');
    if (h && !pats.some((p) => p.endsWith('//' + h + '/*') || p.endsWith('.' + h + '/*'))) pats.push(`*://${h}/*`);
  }
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: pats }); } catch (e) {}
  return tabs.find((t) => t && t.id != null && /^https?:/.test(t.url || '')) || null;
}

// The site's base URL (from the source's match / api host) — where a tab is opened to establish the
// in-session context the page-context fetch needs.
export function siteBaseUrl(adapter) {
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
export async function ensureSiteFetch(adapter, { open = false } = {}) {
  const existing = await resolveSiteFetch(adapter);
  if (existing || !open) return existing;
  let tab; try { tab = await chrome.tabs.create({ url: siteBaseUrl(adapter), active: true }); } catch (e) { return null; }
  if (!tab || tab.id == null) return null;
  await waitTabComplete(tab.id);
  return makePageFetch(tab.id);
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
