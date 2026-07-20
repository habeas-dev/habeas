// Resolving a source's captured session auth. Auth is stored under the host it was SEEN on
// (`auth:<host>` in storage.session). But one account token often rides SEVERAL sibling hosts — e.g.
// IKEA replays the same JWT to `cssom-prod.ingka.com` (its GraphQL api.host) AND `api.wlo.ingka.com`,
// both `ingka.com`. Looking only at api.host would miss a token captured on a sibling. So we merge every
// captured host that shares a registrable domain with one of the source's own hosts (api.host,
// crossDomainHosts, match), with the api.host's own capture taking precedence on conflicts.
import { chrome } from './ext.js';
import { registrableDomain } from '../adapters/validate.js';

const stripHost = (h) => String(h || '').replace(/^https?:\/\//, '').replace(/[:/].*$/, '');

// The registrable domains a source legitimately touches — the trust boundary for merging tokens.
function sourceDomains(adapter) {
  const out = new Set();
  const hosts = [adapter.api && adapter.api.host, ...(adapter.crossDomainHosts || []), ...(adapter.match || [])];
  for (const h of hosts) { const d = registrableDomain(stripHost(h)); if (d) out.add(d); }
  return out;
}

// Returns { byPath, merged, ctx } or null when nothing was captured (a cookie source returns an empty
// store — its cookies carry the session). Accepts a preloaded `all` (storage.session snapshot) to avoid
// a second read when the caller already has one.
export async function loadAuth(adapter, all) {
  const cookie = adapter.auth && adapter.auth.mode === 'cookie';
  const apiHost = stripHost(adapter.api && adapter.api.host);
  const domains = sourceDomains(adapter);
  const store = all || (await chrome.storage.session.get(null));
  const keys = Object.keys(store).filter((k) => k.startsWith('auth:') && domains.has(registrableDomain(k.slice(5))));
  if (!keys.length) return cookie ? { byPath: {}, merged: {}, ctx: {} } : null;
  const primary = store['auth:' + apiHost];
  const merged = {}, ctx = {};
  // siblings first, then the api.host's own capture LAST so it wins on conflicts
  for (const k of keys) { if (k === 'auth:' + apiHost) continue; Object.assign(merged, store[k].merged || {}); Object.assign(ctx, store[k].ctx || {}); }
  if (primary) { Object.assign(merged, primary.merged || {}); Object.assign(ctx, primary.ctx || {}); }
  return { byPath: (primary && primary.byPath) || {}, merged, ctx };
}

// May the source's token be captured from a request to this path? A source can DECLARE where its token
// lives, so capture (and the webRequest observer's URL filter) stays off the login flow and any anonymous
// endpoint — keeping the extension's footprint off the sensitive sign-in requests and ensuring the token is
// only ever taken from the authenticated area (e.g. FECI's `/dashboard/*`, which only appears after login):
//   auth.capturePaths — an ALLOWLIST of path prefixes; capture ONLY from these (nothing else).
//   auth.ignorePaths  — a DENYLIST of path prefixes; never capture from these.
// A denylist hit always wins; with a capturePaths allowlist, a path must match it. No lists → capture anywhere
// (unchanged behavior). Prefixes (not regex) so the same list can build a webRequest URL filter.
export function capturePathAllowed(adapter, path) {
  const au = adapter && adapter.auth; if (!au) return true;
  const p = String(path || '');
  const norm = (x) => (String(x).startsWith('/') ? String(x) : '/' + String(x));
  const hit = (list) => Array.isArray(list) && list.some((x) => p.startsWith(norm(x)));
  if (hit(au.ignorePaths)) return false;
  if (Array.isArray(au.capturePaths) && au.capturePaths.length) return hit(au.capturePaths);
  return true;
}

// True if a usable session was captured for this source (any sibling host counts).
export async function hasAuth(adapter, all) {
  const a = await loadAuth(adapter, all);
  if (!a) return false;
  if (adapter.auth && adapter.auth.mode === 'cookie') return true;
  return Object.keys(a.merged).length > 0;
}
