// Fetch FROM the target site's own page context (a tab on the site) instead of from an
// extension page. This is the core of the "in-session" thesis: a request made inside the site's
// tab inherits the user's full session — cookies, cf_clearance, and the browser's TLS/header
// fingerprint — so Cloudflare/Akamai let it through. A fetch from a chrome-extension:// page looks
// different and gets challenged (HTTP 403 "Just a moment…").
import { chrome } from './ext.js';

// Returns a fetch-like function bound to a tab, yielding a minimal Response ({ ok, status, text,
// json, blob }). Binary bodies (PDFs) are marshalled as base64 across the executeScript boundary.
export function makePageFetch(tabId) {
  return async (url, init = {}) => {
    const arg = {
      url: String(url),
      method: (init.method || 'GET'),
      headers: init.headers || {},
      body: typeof init.body === 'string' ? init.body : null,
      wantBlob: !!init.wantBlob,
      referrer: init.referrer || null, // set from the tab (same-origin) — the reliable way to spoof Referer
    };
    let out;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [arg],
        func: async (o) => {
          try {
            const r = await fetch(o.url, { method: o.method, headers: o.headers, body: o.body || undefined, credentials: 'include', ...(o.referrer ? { referrer: o.referrer, referrerPolicy: 'unsafe-url' } : {}) });
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
  // A source can point the login tab at its actual sign-in page (e.g. WiZink's /login) instead of the
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
  // Reload the open site tab (now cookieless → clean login) or open one; focus it so the user logs in.
  const tab = await findSiteTab(adapter);
  try {
    if (tab) { await chrome.tabs.update(tab.id, { active: true }); await chrome.tabs.reload(tab.id); }
    else await chrome.tabs.create({ url: siteBaseUrl(adapter), active: true });
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
