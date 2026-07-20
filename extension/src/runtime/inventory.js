// Adapter runtime: given an adapter (declarative data) + captured auth, enumerate all
// documents and fetch a document's PDF. Runs in an extension page (host_permissions grant the
// cross-origin fetch without CORS).
//
// The pager is declarative — an adapter picks a `paging` strategy and the field mapping; the
// runtime stays source-agnostic. Carrefour uses `offsets` paging; other sources use
// `page` / `cursor` / `none`.
import { buildRecord } from '../sinks/format.js';
import { applyNormalize } from '../lib/normalize.js';
import { chrome } from '../lib/ext.js';
import { registrableDomain, hostOf } from '../adapters/validate.js';
import { esc as escH } from '../lib/esc.js';

// Every fetcher goes through the site's tab (in-session: cookies + cf_clearance + fingerprint, so anti-bot
// lets it through). But a page-context fetch is bound by THAT page's CSP (connect-src) and can throw a
// network-level error (status 0 — "Failed to fetch") when the tab sits on a page that doesn't allow the API
// host (e.g. Carrefour's home/login page vs its account SPA). On such a failure, retry DIRECTLY from the
// extension: for a CORS-open API host granted in host_permissions (Carrefour's pro.api.carrefour.es, not
// behind anti-bot) the direct fetch succeeds and bypasses the page CSP; if the token is merely expired it
// returns a clean 4xx instead of an opaque network error. A 4xx/5xx from the tab is a real HTTP response
// (anti-bot 403 included) → NOT retried, so Cloudflare-gated sources still rely on the tab. No tab → the
// direct fetch is the only path anyway.
// Declarative anti-fingerprinting throttle: a source may set `throttle: { minMs, jitterMs }` so its API
// calls aren't fired back-to-back at machine speed (which can flag automation). Enforced per HOST here, the
// single network choke point, so it covers listing pages, detail and document fetches uniformly. The jitter
// (a random 0..jitterMs added to minMs each time) avoids a tell-tale exact cadence.
const LAST_CALL = new Map(); // host → last request time (ms)
async function throttleGate(throttle, url) {
  if (!throttle || !(throttle.minMs > 0)) return;
  let host = ''; try { host = new URL(url).host; } catch (e) {}
  const target = throttle.minMs + (throttle.jitterMs > 0 ? Math.random() * throttle.jitterMs : 0);
  const since = Date.now() - (LAST_CALL.get(host) || 0);
  if (LAST_CALL.has(host) && since < target) await new Promise((r) => setTimeout(r, target - since));
  LAST_CALL.set(host, Date.now());
}
export function netFetch(net, throttle) {
  const base = net
    ? async (u, i) => { let r; try { r = await net(u, i); } catch (e) { r = null; } if (!r || r.status === 0) { try { return await fetch(u, i); } catch (e) { if (r) return r; throw e; } } return r; }
    : (u, i) => fetch(u, i);
  if (!throttle || !(throttle.minMs > 0)) return base;
  return async (u, i) => { await throttleGate(throttle, u); return base(u, i); };
}

// Cookie policy for the source's own API calls. Default 'include' (a cookie-authed source needs its
// session cookie; a bearer source that also carries a CSRF cookie needs it too). A token-only source
// can opt out with `auth.cookies: false` — some bank APIs (Openbank) authenticate purely by the token
// header and REJECT the request when the browser attaches its large cookie jar (HTTP 413, oversized
// request headers). Omitting cookies there mirrors exactly what the site's own SPA sends.
function credOf(adapter) {
  return adapter && adapter.auth && adapter.auth.cookies === false ? 'omit' : 'include';
}

// Some services gate the PDF behind a Referer that must be the document's detail page. A page/
// extension fetch cannot set Referer (forbidden header) — declarativeNetRequest is the MV3 way.
let __ruleSeq = 1;
async function withReferer(targetUrl, referer, fn) {
  if (!referer || !(chrome && chrome.declarativeNetRequest)) return fn();
  const id = 100000 + ((__ruleSeq++) % 90000);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: referer }] },
        condition: { urlFilter: (targetUrl || '').split('?')[0], resourceTypes: ['xmlhttprequest'] },
      }],
    });
  } catch (e) { return fn(); }
  try { return await fn(); }
  finally { try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }); } catch (e) {} }
}

// Enumerate a source's documents. A source with `api.groups` (e.g. a bank: many accounts) enumerates
// the groups first, then lists each group's items with {group.*} templated into the list request; each
// record carries its group (doc._group). Without groups, it's a single flat listing.
// True if an ISO/parseable date is no older than `days` days from now. Unparseable → kept (don't drop
// on a formatting quirk). Used by maxAgeDays to avoid a bank's older-than-N-days extra-auth wall.
function withinAgeDays(dateStr, days) {
  const t = Date.parse(dateStr);
  if (isNaN(t)) return true;
  return (Date.now() - t) <= days * 86400000;
}

export async function listInventory(adapter, auth, net, opts) {
  const list = (adapter.api && adapter.api.list) || {};
  const byDate = (x, y) => (x.date < y.date ? 1 : -1);
  // maxAgeDays: never surface documents older than N days — keeps a source from requesting statements
  // past a bank's extra-auth wall (WiZink asks for an SMS beyond ~90 days). For a periods source the
  // cut is applied at the statement-date level BEFORE fetching (see pageListPeriods); here it drops
  // finished statement documents (XLS/PDF) so they're never downloaded.
  const capAge = (docs) => (list.maxAgeDays && !list.periods) ? docs.filter((d) => withinAgeDays(d.date, list.maxAgeDays)) : docs;
  // WebSocket-API source (Trade Republic): the whole connect→sub→paginate loop runs in the site tab via
  // net.ws and returns a flat items array. Map each item like any list row. No HTTP list/groups.
  if (adapter.api && adapter.api.ws) {
    const wsFn = net && net.ws;
    if (!wsFn) throw new Error('list ws — no WebSocket transport (open the site tab first)');
    const res = await wsFn({ ...adapter.api.ws });
    if (res && res.error) throw new Error('list ws — ' + res.error);
    const seen = new Set(opts && opts.knownIds ? opts.knownIds : []), all = [];
    for (const it of (res && res.items) || []) {
      const doc = mapDoc(adapter, it, null);
      const id = doc.internalId;
      if (id != null && seen.has(id)) continue;
      if (id != null) seen.add(id);
      all.push(doc);
    }
    all.sort(byDate);
    return capAge(all);
  }
  // mtop-API source (AliExpress…): the page-context executor returns each page's raw response; extract the
  // component-keyed items (itemsFromKeys) from every page and map each like a list row.
  if (adapter.api && adapter.api.mtop) {
    const mtopFn = net && net.mtop;
    if (!mtopFn) throw new Error('list mtop — no mtop transport (open the site tab first)');
    const res = await mtopFn({ ...adapter.api.mtop });
    if (res && res.error) throw new Error('list mtop — ' + res.error);
    const listCfg = { itemsFromKeys: adapter.api.itemsFromKeys };
    const seen = new Set(opts && opts.knownIds ? opts.knownIds : []), all = [];
    for (const page of (res && res.pages) || []) {
      for (const it of getItems(page, listCfg)) {
        const doc = mapDoc(adapter, it, null);
        const id = doc.internalId;
        if (id != null && seen.has(id)) continue;
        if (id != null) seen.add(id);
        all.push(doc);
      }
    }
    all.sort(byDate);
    return capAge(all);
  }
  // CSRF prelude (AEM/WiZink): fetch a page, extract the securityToken, expose it as {csrf} in every
  // subsequent list/group/pdf template via auth.__csrf.
  const a = adapter.api.csrf ? { ...(auth || {}), __csrf: await fetchCsrf(adapter, auth, net) } : auth;
  if (adapter.api.groups) {
    let groups = await listGroups(adapter, a, net);
    // opts.groupId restricts to one account (a consumer's collect{group} asks for a single account).
    if (opts && opts.groupId != null) groups = groups.filter((g) => String(g.id) === String(opts.groupId));
    // opts.groups: a persisted per-datasource allow-list — only these accounts are offered/listed. Absent
    // or empty → all accounts (backward-compatible). Ids compared as strings.
    else if (opts && opts.groups && opts.groups.length) { const allow = new Set(opts.groups.map(String)); groups = groups.filter((g) => allow.has(String(g.id))); }
    const all = [];
    let errs = 0, lastErr;
    // Tolerate a single account failing (e.g. a product with no transactions endpoint → 404): don't let it
    // kill the whole run. But if EVERY account failed (e.g. no session), surface the error to the caller.
    for (const g of groups) {
      try { all.push(...await pageList(adapter, a, net, g, opts)); }
      catch (e) { errs++; lastErr = e; }
    }
    if (groups.length && errs === groups.length) throw lastErr;
    all.sort(byDate);
    return capAge(all);
  }
  const all = await pageList(adapter, a, net, null, opts);
  all.sort(byDate);
  return capAge(all);
}

// CSRF prelude: GET a page and extract a token (e.g. WiZink's securityToken hidden input / JS var) with
// a regex (adapter.api.csrf.match, capture group 1). Reused as {csrf} in POST bodies and PDF URLs.
async function fetchCsrf(adapter, auth, net) {
  const NET = netFetch(net, adapter && adapter.throttle);
  const c = adapter.api.csrf;
  const host = c.host ? absHost(c.host) : adapter.api.host;
  const url = host + c.path;
  const init = { method: c.method || 'GET', headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...(c.headers || {}), ...headersFor(auth, c.path, false) }, credentials: credOf(adapter) };
  const res = await NET(url, init);
  if (!res.ok) throw new Error('csrf ' + res.status);
  const m = (await res.text()).match(new RegExp(c.match));
  if (!m) throw new Error('csrf token not found (not logged in?)'); // 200 but the page isn't the logged-in one
  return m[1];
}

// Enumerate the accounts/cards/portfolios a source groups its items by (id/name/… per adapter.api.groups.fields).
// Cheap — no item data. Used by the runtime (per-group listing) and by the external `listGroups` hook.
export async function listGroups(adapter, auth, net) {
  const g = adapter.api.groups;
  if (!g) return [];
  // Self-contained: if the source needs a CSRF token and one isn't already on auth (a direct caller —
  // the group picker or the external listGroups hook), run the prelude here. listInventory passes an
  // auth that already has __csrf, so it isn't fetched twice.
  const a = adapter.api.csrf && !(auth && auth.__csrf) ? { ...(auth || {}), __csrf: await fetchCsrf(adapter, auth, net) } : auth;
  const items = await fetchGroupItems(adapter, a, net);
  const seen = new Set(), out = [];
  for (const item of (items || [])) {
    const grp = { _raw: item };
    for (const k of Object.keys(g.fields || {})) grp[k] = get(item, g.fields[k]);
    // `derive`: compute extra group fields from mapped ones with simple, auditable string ops — trim and a
    // [start,end] slice. Banks often pack several values into one string (Openbank's BBAN carries the
    // control digit + account number), so a source can split them out declaratively: e.g.
    //   derive: { digitoControl: { from: "bban", trim: true, slice: [8, 10] } }
    for (const [k, d] of Object.entries(g.derive || {})) {
      let v = grp[d.from]; v = v == null ? '' : String(v);
      if (d.trim) v = v.trim();
      if (Array.isArray(d.slice)) v = v.slice(d.slice[0], d.slice[1]);
      grp[k] = v;
    }
    if (grp.id != null && grp.id !== '' && seen.has(grp.id)) continue; // dedup (repeated onclick handlers per card)
    if (grp.id != null && grp.id !== '') seen.add(grp.id);
    out.push(grp);
  }
  return out;
}
async function fetchGroupItems(adapter, auth, net) {
  const NET = netFetch(net, adapter && adapter.throttle);
  const g = adapter.api.groups;
  const host = g.host ? absHost(g.host) : adapter.api.host;
  const path = fillCtx(g.path, auth); // {ctx.*} — e.g. a captured DNI in /posicionGlobal/es/{ctx.dni}
  const qs = g.params ? new URLSearchParams(g.params).toString() : '';
  const url = host + path + (qs ? '?' + qs : '');
  const isHtml = g.from === 'html';
  const cookie = adapter.auth && adapter.auth.mode === 'cookie';
  const accept = isHtml ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' : 'application/json';
  const method = (g.method || 'GET').toUpperCase();
  const init = { method, headers: { accept, ...(g.headers || {}), ...headersFor(auth, path, true /*allow captured replay headers (cookie sources only ever capture replayHeaders like x-device-id, never a token)*/) }, credentials: credOf(adapter) };
  if (method === 'POST' && g.body != null) { init.body = fillTmpl(g.body, null, auth, g.params || {}); init.headers['content-type'] = g.contentType || 'application/x-www-form-urlencoded'; }
  if (g.referer) init.referrer = g.referer;
  const res = await withReferer(url, g.referer || null, () => NET(url, init));
  if (!res.ok) throw new Error('groups ' + res.status + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120) + ' [sent: ' + (res.sentHeaders || Object.keys(init.headers || {})).join(',') + ']');
  if (isHtml) return extractListItems(await res.text(), g); // embedded state → itemsPath
  return get(await res.json(), g.itemsPath) || [];
}

async function pageList(adapter, auth, net, group, opts) {
  const list = adapter.api.list;
  // Multi-period sources (WiZink card movements) assemble a group's list from several period fetches
  // (current month + one per past statement) instead of a single paged endpoint — handled apart.
  if (list.periods) return pageListPeriods(adapter, auth, net, group, opts);
  // Year-partitioned listing (e.g. Amazon's /your-orders, which filters by year and has no global
  // list): scan a bounded window of years, each with optional startIndex sub-paging.
  if (list.paging === 'years' || list.years) return pageListYears(adapter, auth, net, group, opts);
  // Resolve the strategy from an explicit `paging`, else from whichever paging field is present
  // (robust to a blank `paging` — e.g. an editor/UI that didn't offer the right option).
  const paging = list.paging
    || (list.offsetsPath ? 'offsets' : list.offsetParam ? 'offset' : list.pageParam ? 'page' : (list.nextPath || list.cursorFromItem) ? 'cursor' : 'none');
  const stop = () => !!(opts && opts.signal && opts.signal.aborted); // Stop pressed → end paging, keep what's collected
  const report = (info) => { if (opts && opts.onProgress) { try { opts.onProgress({ ...info, docs: all }); } catch (e) {} } }; // live progress + partial results
  const baseParams = { ...(list.params || {}) };
  const range = rangeParams(list);
  const count = list.params && list.params.count;
  const maxPages = list.maxPages || 100;
  const seen = new Set(opts && opts.knownIds ? opts.knownIds : []), all = []; // incremental: seed with store ids → known items dedup out + paging stops early
  const call = (params) => fetchList(adapter, auth, params, net, group);

  // paramSets: some UIs split "all" into a FIXED set of disjoint filter-views rather than pages (FECI's
  // movements arrive as monthFilter=N/A/S tabs). Replay each set the SPA uses and UNION them, deduped by
  // internalId. Derived straight from the recording (the exact param sets the app fetched).
  if (Array.isArray(list.paramSets)) {
    for (let i = 0; i < list.paramSets.length; i++) {
      if (stop()) break;
      const data = await call({ ...range, ...baseParams, ...list.paramSets[i] });
      collect(adapter, data, seen, all, group);
      report({ page: i + 1 });
    }
    return all.sort((x, y) => ((x.date || '') < (y.date || '') ? 1 : -1));
  }

  if (paging === 'offsets') {
    let offs = { ...(list.initialOffsets || {}) };
    for (let g = 0; g < maxPages; g++) {
      if (stop()) break;
      const data = await call({ ...range, ...baseParams, ...offs });
      const added = collect(adapter, data, seen, all, group);
      report({ page: g + 1 });
      if (!added) break;
      offs = Object.assign(offs, get(data, list.offsetsPath) || {});
    }
  } else if (paging === 'page') {
    const pageParam = list.pageParam || 'page';
    let page = list.pageStart ?? 1;
    const tolerate = list.stopAfterEmpty || 0; // consecutive pages contributing NOTHING to skip before stopping
    let dryStreak = 0;
    for (let g = 0; g < maxPages; g++) {
      if (stop()) break;
      const data = await call({ ...range, ...baseParams, [pageParam]: page });
      const added = collect(adapter, data, seen, all, group);
      report({ page: g + 1 });
      // A page that adds NOTHING NEW (empty, OR — incrementally — all-known) is a candidate stop. For a
      // year-partitioned list (pageParam yearOffset) an empty/known year in the MIDDLE (e.g. 2025 with no
      // purchases, or the current year already in the store) doesn't mean older years are done, so tolerate
      // `stopAfterEmpty` such pages before stopping. Default 0 → stop at the first dry page (unchanged).
      if (!added) { if (++dryStreak > tolerate) break; }
      else dryStreak = 0;
      page++;
    }
  } else if (paging === 'offset') {
    const offsetParam = list.offsetParam || 'offset';
    const step = list.offsetStep || count || 20;
    let offset = list.offsetStart ?? 0;
    for (let g = 0; g < maxPages; g++) {
      if (stop()) break;
      const data = await call({ ...range, ...baseParams, [offsetParam]: offset });
      const items = getItems(data, list);
      const added = collect(adapter, data, seen, all, group);
      report({ page: g + 1 });
      if (!items.length || !added) break;
      offset += step;
    }
  } else if (paging === 'cursor') {
    const cursorParam = list.cursorParam || 'cursor';
    let cursor = null;
    for (let g = 0; g < maxPages; g++) {
      if (stop()) break;
      await maybeKeepAlive(adapter, auth, net); // long paged listings can outlive a short-lived session
      let data;
      if (list.nextIsUrl && cursor) data = await fetchAbsList(adapter, auth, cursor, net); // cursor IS the full next-page URL
      else {
        const params = { ...range, ...baseParams };
        // `cursorParams` ride ONLY with a cursor: some APIs (Openbank) send a "this is a continuation"
        // flag (`hasMorePagination:S`) alongside the memento on pages 2+, but NOT on the first request —
        // sending it on page 1 makes the server return an empty page. First call = base params only.
        if (cursor) { params[cursorParam] = cursor; Object.assign(params, list.cursorParams || {}); }
        data = await call(params);
      }
      // Step-up (SCA/OTP) boundary: a flag meaning "older data needs a one-time code the user didn't ask
      // for" (Openbank's `scaRequired` past ~90 days). Keep what THIS page returned — it arrived without a
      // challenge — then STOP. Habeas never crosses the boundary, so no SMS/OTP is ever triggered.
      const scaStop = list.stopPath && String(get(data, list.stopPath)) === String(list.stopValue ?? true);
      const added = collect(adapter, data, seen, all, group);
      report({ page: g + 1 });
      if (scaStop) break;
      // `cursorFromItem`: the next cursor is derived from the PAGE's own items, not a field in the response
      // envelope — for time-windowed lists that page by "give me rows before this timestamp" (Revolut's
      // `to` = the oldest row's startedDate). Take the MIN across the page; dedup by id absorbs the overlap.
      if (list.cursorFromItem) {
        const items = getItems(data, list);
        let mn = null; for (const it of items) { const v = Number(get(it, list.cursorFromItem)); if (!isNaN(v)) mn = mn == null ? v : Math.min(mn, v); }
        cursor = items.length && mn != null ? mn : null; // no items → stop
      } else cursor = get(data, list.nextPath);
      // Some APIs keep a cursor even on the last page and signal "more" with a separate flag (Openbank:
      // `memento` + `hasMore: "S"`, or `_links.nextPage.href` + `masMovimientos: true`). When `morePath` is
      // declared, continue only while it equals `moreValue` (default "S"); else keep going while a cursor exists.
      const more = list.morePath ? String(get(data, list.morePath)) === String(list.moreValue ?? 'S') : true;
      if (!added || !cursor || !more) break;
    }
  } else if (paging === 'synthetic') {
    // No API list to page — the documents exist once per GROUP (a per-account report over the window) or
    // once per PERIOD (a monthly statement). Build the items locally; each maps to one doc → one file.
    for (const p of synthItems(list, group)) {
      const doc = mapDoc(adapter, p, group);
      if (doc.internalId != null && seen.has(doc.internalId)) continue;
      if (doc.internalId != null) seen.add(doc.internalId);
      all.push(doc);
    }
  } else { // 'none' — single request
    collect(adapter, await call({ ...range, ...baseParams }), seen, all, group);
  }
  return all; // sorted by the caller (listInventory) across all groups
}

// Synthetic list items — for DOCUMENTS not enumerated by an API list. `synthetic.each`:
//  - "months": one item per calendar month back to `maxAgeDays` (a monthly statement, e.g. ING's integrated
//    extract) — item carries {year, month, period, date}.
//  - "group":  one item = the current account/group (a per-account report over the window).
// The window range is attached to each item's _raw so a pdf template can read {fromDate}/{toDate}/{year}/…
function synthItems(list, group) {
  const s = list.synthetic || {};
  const rangeVals = {};
  if (list.window || list.range) {
    rangeVals.fromDate = new Date(Date.now() - windowMs(list.window)).toISOString().slice(0, 10);
    rangeVals.toDate = new Date().toISOString().slice(0, 10);
  }
  // Only COMPLETED months — the current, in-progress month has no final statement yet, so its last day
  // must be strictly before today (00:00 UTC) for the month to count.
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (s.each === 'months') {
    const out = [];
    const cutoff = Date.now() - (list.maxAgeDays || 90) * 86400000;
    let y = now.getUTCFullYear(), m = now.getUTCMonth() + 1; // 1-12
    for (let i = 0; i < 36; i++) {
      const first = new Date(Date.UTC(y, m - 1, 1)), last = new Date(Date.UTC(y, m, 0)); // first/last day of month y-m
      if (last.getTime() < cutoff) break;       // whole month older than the window → stop
      // Each month carries its OWN bounds (fromDate/toDate) so a per-month statement/export can request them,
      // NOT just the window range — a document endpoint that takes from&to (Trade Republic CSV export).
      if (last.getTime() < todayStart) out.push({ year: String(y), month: String(m), period: `${y}-${String(m).padStart(2, '0')}`, date: last.toISOString().slice(0, 10), fromDate: first.toISOString().slice(0, 10), toDate: last.toISOString().slice(0, 10), ...rangeVals });
      m--; if (m < 1) { m = 12; y--; }
    }
    return out;
  }
  // The group's own fields (id, name + any `derive`d scalars like Openbank's digitoControl/numeroCuenta)
  // are folded into each synthetic item's _raw, so a `keepRaw` source persists them in record.extra and a
  // store re-download can rebuild the download URL after the transient _group is gone.
  const gf = group ? Object.fromEntries(Object.entries(group).filter(([k, v]) => k !== '_raw' && (v == null || typeof v !== 'object'))) : {};
  if (s.each === 'group') {
    if (!group) return [];
    return [{ ...(group._raw || {}), ...gf, ...rangeVals, date: rangeVals.toDate || new Date().toISOString().slice(0, 10) }];
  }
  // "group-months": one item per (account × month) — a MONTHLY per-account statement (like WiZink's). Each
  // item carries that month's fromDate/toDate so a range-report endpoint returns just that month.
  if (s.each === 'group-months') {
    if (!group) return [];
    const out = [];
    const cutoff = Date.now() - (list.maxAgeDays || 90) * 86400000;
    let y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
    for (let i = 0; i < 36; i++) {
      const first = new Date(Date.UTC(y, m - 1, 1)), last = new Date(Date.UTC(y, m, 0));
      if (last.getTime() < cutoff) break;
      if (last.getTime() < todayStart) out.push({ ...(group._raw || {}), ...gf, year: String(y), month: String(m), period: `${y}-${String(m).padStart(2, '0')}`,
        date: last.toISOString().slice(0, 10), fromDate: first.toISOString().slice(0, 10), toDate: last.toISOString().slice(0, 10) });
      m--; if (m < 1) { m = 12; y--; }
    }
    return out;
  }
  return [];
}

// Year-partitioned pager. Some services (Amazon /your-orders) only expose orders one year at a time
// via a `timeFilter=year-YYYY` param, with `startIndex` sub-paging inside each year. `list.years`:
//   { param:"timeFilter", format:"year-{y}", back:6, startParam?:"startIndex", startStep?:10 }
// Scans from the current year back `back` years (bounded); dedupes across years by internalId; caps
// total fetched pages at list.maxPages. Sub-paging within a year stops on an empty / all-seen page.
async function pageListYears(adapter, auth, net, group, opts) {
  const list = adapter.api.list;
  const stop = () => !!(opts && opts.signal && opts.signal.aborted);
  const y = list.years || {};
  const param = y.param || 'timeFilter';
  const format = y.format || 'year-{y}';
  const back = y.back != null ? y.back : 25;               // safety cap on how far back to look
  const stopEmpty = y.stopAfterEmpty != null ? y.stopAfterEmpty : 2; // stop after N consecutive empty years
  const startParam = y.startParam;          // optional within-year offset param (e.g. startIndex)
  const startStep = y.startStep || 10;      // its increment (page size)
  const maxPages = list.maxPages || 100;
  const baseParams = { ...(list.params || {}) };
  const now = new Date().getFullYear();
  const seen = new Set(opts && opts.knownIds ? opts.knownIds : []), all = []; // incremental: seed with store ids → known items dedup out + paging stops early
  let pages = 0, emptyRun = 0;
  // Walk years back until N consecutive years are empty (adapts to each account's real history — a fixed
  // `back` would truncate older orders) or the safety cap / page cap / Stop is hit. stopAfterEmpty>1
  // tolerates a year with no purchases in the middle.
  for (let yr = now; yr >= now - back && pages < maxPages && emptyRun < stopEmpty; yr--) {
    if (stop()) break;
    const yv = format.split('{y}').join(String(yr));
    let yearItems = 0, yearAdded = 0;
    for (let idx = 0; pages < maxPages; idx += startStep) {
      if (stop()) break;
      const params = { ...baseParams, [param]: yv };
      if (startParam && idx > 0) params[startParam] = idx; // first page carries no startIndex (matches the site)
      const data = await fetchList(adapter, auth, params, net, group);
      const items = getItems(data, list);
      // Stamp the page's year onto each item so the listing carries at least year precision (the full date
      // is encrypted in the list; it's recovered from the per-order detail). Map it via fields.date:"_year".
      for (const it of items) if (it && typeof it === 'object' && it._year == null) it._year = String(yr);
      const added = collect(adapter, data, seen, all, group);
      pages++;
      yearItems += items.length; yearAdded += added;
      if (opts && opts.onProgress) { try { opts.onProgress({ year: yr, page: (idx / startStep) + 1, docs: all }); } catch (e) {} } // live: "listing 2026, page 3"
      if (!startParam || !items.length || !added) break; // no sub-paging, or empty / nothing new → next year
    }
    // Incremental: a year already fully in the store (0 new) means everything older is known too → stop.
    if (opts && opts.knownIds && yearItems > 0 && yearAdded === 0) break;
    emptyRun = yearItems === 0 ? emptyRun + 1 : 0;
  }
  return all;
}

// Multi-period list assembly (e.g. WiZink card movements): a group's movements aren't one paged list
// but SEVERAL period fetches — the current (unbilled) month plus one fetch per past monthly statement
// — each parsed with the SAME shared row parser (list.rows) and concatenated. Shape:
//   list.periods = {
//     current: { params, body },                    // this month's movements (one response)
//     dates:   { params, body, rows },              // → the past statement dates (rows extracts them)
//     past:    { params, body /* body may use {period} = a statement date */ },
//   }
// The CSRF token is single-use, so it's refetched before every period fetch. Statements older than the
// site's ~90-day extra-auth wall fail / return nothing → those fetches are skipped (logged via opts.log),
// never fatal; we stop after 2 consecutive misses. list.maxPeriods caps the fan-out (default 24).
async function pageListPeriods(adapter, auth, net, group, opts) {
  const list = adapter.api.list;
  const P = list.periods || {};
  const rows = list.rows;                           // shared movement-row parser (current + past)
  const maxPeriods = list.maxPeriods || 24;
  const log = (opts && typeof opts.log === 'function') ? opts.log : () => {};
  const gname = (group && (group.accountNumber != null ? group.accountNumber : group.id)) || '';
  const raw = [];
  const refresh = async () => (adapter.api.csrf ? { ...(auth || {}), __csrf: await fetchCsrf(adapter, auth, net) } : (auth || {}));
  const tag = (items, period) => items.forEach((it, i) => { it._period = period; it._idx = i; raw.push(it); });

  // 1. current (unbilled) month — every movement is in this one response (no server pagination).
  if (P.current) {
    try { tag(parseHtmlItems(await fetchPeriodHtml(adapter, await refresh(), net, group, P.current), rows), 'current'); }
    catch (e) { log(`${adapter.service || 'source'} ${gname}: current-month movements failed — ${e.message}`); }
  }
  // 2. past statement dates (each a callOperations('YYYY-MM-DD') on the card page).
  let dates = [];
  if (P.dates) {
    try { dates = parseHtmlItems(await fetchPeriodHtml(adapter, await refresh(), net, group, P.dates), P.dates.rows || rows).map((r) => r.statementDate).filter(Boolean); }
    catch (e) { log(`${adapter.service || 'source'} ${gname}: statement-date list failed — ${e.message}`); }
  }
  dates = [...new Set(dates)].slice(0, maxPeriods); // newest-first as the site returns them; cap fan-out
  if (list.maxAgeDays) { // proactively drop statements past the extra-auth wall — requesting them is what triggers the SMS
    const before = dates.length;
    dates = dates.filter((d) => withinAgeDays(d, list.maxAgeDays));
    if (dates.length < before) log(`${adapter.service || 'source'} ${gname}: skipping ${before - dates.length} statement(s) older than ${list.maxAgeDays}d (avoids extra-auth SMS)`);
  }
  // 3. one fetch per past statement. Stop after 2 consecutive empty/failed fetches — the ~90-day
  //    extra-auth wall makes older statements unreachable; skip gracefully rather than abort the list.
  let misses = 0;
  for (const d of dates) {
    if (misses >= 2) { log(`${adapter.service || 'source'} ${gname}: stopping past statements at ${d} (hit the ~90-day auth wall)`); break; }
    let items = null;
    try { items = parseHtmlItems(await fetchPeriodHtml(adapter, await refresh(), net, group, P.past, { period: d }), rows); }
    catch (e) { log(`${adapter.service || 'source'} ${gname}: statement ${d} skipped — ${e.message}`); }
    if (!items || !items.length) { if (items) log(`${adapter.service || 'source'} ${gname}: statement ${d} had no movements — skipped`); misses++; continue; }
    misses = 0;
    tag(items, d);
  }
  // Map + dedup exactly like the paged path (collect builds each doc's record + internalId).
  const seen = new Set(opts && opts.knownIds ? opts.knownIds : []), all = []; // incremental: seed with store ids → known items dedup out + paging stops early
  collect(adapter, { __items: raw }, seen, all, group);
  return all;
}

// POST one period page (current / dates / past) and return its raw HTML. Mirrors fetchList's request
// shape: query string = periodCfg.params, form body = periodCfg.body with {group.*}/{csrf}/{period} filled.
async function fetchPeriodHtml(adapter, auth, net, group, periodCfg, extra) {
  const NET = netFetch(net, adapter && adapter.throttle);
  const list = adapter.api.list;
  const path = tmplGroup(list.path, group);
  const params = periodCfg.params || {};
  const gparams = {}; for (const k of Object.keys(params)) gparams[k] = tmplGroup(String(params[k]), group);
  const qs = new URLSearchParams(gparams).toString();
  const url = adapter.api.host + path + (qs ? '?' + qs : '');
  const cookie = adapter.auth && adapter.auth.mode === 'cookie';
  const htmlAccept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  const method = (list.method || 'POST').toUpperCase();
  const init = { method, headers: { accept: htmlAccept, ...(list.headers || {}), ...headersFor(auth, path.split('?')[0], true /*allow captured replay headers (cookie sources only ever capture replayHeaders like x-device-id, never a token)*/) }, credentials: credOf(adapter) };
  if (periodCfg.body != null) {
    init.body = fillTmpl(periodCfg.body, group, auth, extra || {}); // {group.*} + {csrf} + {period}
    init.headers['content-type'] = list.contentType || 'application/x-www-form-urlencoded';
  }
  const res = await NET(url, init);
  if (!res.ok) throw new Error('period ' + res.status + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
  return await res.text();
}

const absHost = (h) => (/^https?:\/\//.test(h) ? h : 'https://' + h);
// The registrable domains a source may fetch a document from: its own domain plus any declared
// crossDomainHosts. Guards absolute-URL documents (pdf.urlField) so an item's `Url` can only point
// back at the same service the session was captured from — the runtime mirror of validate#checkHosts.
function assertAllowedDocHost(adapter, absUrl) {
  let h; try { h = new URL(absUrl).host; } catch (e) { throw new Error('document URL invalid'); }
  const base = registrableDomain(adapter.domain || (adapter.api && adapter.api.host) || '');
  const allowed = new Set([base, ...(adapter.crossDomainHosts || []).map(registrableDomain)].filter(Boolean));
  if (!allowed.has(registrableDomain(h))) throw new Error('document URL host not allowed: ' + hostOf(h));
}
// Template an id into a path. Don't percent-encode a path/URL-like id (e.g. a row's href
// "/…/receipts/123.pdf") — that would break its slashes; encode only opaque ids.
const tid = (id) => (/[/:]/.test(String(id)) ? String(id) : encodeURIComponent(id));
// Fill a URL/referer template: {internalId} + any {dotted.path} taken from the doc's raw list item
// (e.g. Dia's detail needs {detail_params.begin}/{detail_params.pos}/… from the listed ticket).
const applyTmpl = (str, doc, id) => String(str).replace(/\{([^}]+)\}/g, (m, k) => {
  const v = k === 'internalId' ? id : (doc && doc._raw ? get(doc._raw, k) : undefined);
  return v == null ? m : tid(v);
});
// {group.field} → the current group's (e.g. bank account's) value. Templates the per-group list URL.
const tmplGroup = (str, group) => (group ? String(str).replace(/\{group\.([^}]+)\}/g, (m, k) => { const v = get(group, k); return v == null ? m : tid(v); }) : String(str));
// RAW variant for HEADER values: no URL-encoding — a header carries the value verbatim (e.g. a base64
// encrypted-PAN with +/=; tid()'s encodeURIComponent would corrupt it → the server can't base64-decode).
const tmplGroupRaw = (str, group) => (group ? String(str).replace(/\{group\.([^}]+)\}/g, (m, k) => { const v = get(group, k); return v == null ? m : String(v); }) : String(str));
// Computed calendar-date tokens for path/param/body values, with an optional format. Some SPAs stamp the
// CURRENT billing/period date into a request (e.g. FECI's statement list wants ?date_bill=31/07/2026):
//   {today} {monthStart} {monthEnd}  → ISO YYYY-MM-DD by default
//   {monthEnd:DD/MM/YYYY}            → formatted (FORMAT uses YYYY / MM / DD; anything else is literal)
//   {daysAgo:90}                     → ISO date 90 days before today (a rolling window, e.g. Raisin caps the
//                                      transactions request at date_from=today-90d to stay inside the SCA-free
//                                      window). The arg is the day count; the result is ISO (date-only).
// Dates use the browser's LOCAL calendar (what the SPA itself computed), date-only, so no timezone shift.
export function tmplDates(str) {
  if (typeof str !== 'string' || str.indexOf('{') < 0) return str;
  return str.replace(/\{(today|monthStart|monthEnd|daysAgo)(?::([^}]+))?\}/g, (m, which, arg) => {
    const now = new Date();
    const d = which === 'monthStart' ? new Date(now.getFullYear(), now.getMonth(), 1)
      : which === 'monthEnd' ? new Date(now.getFullYear(), now.getMonth() + 1, 0)
        : which === 'daysAgo' ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - (parseInt(arg, 10) || 0))
          : now;
    const Y = String(d.getFullYear()), M = String(d.getMonth() + 1).padStart(2, '0'), D = String(d.getDate()).padStart(2, '0');
    const fmt = which === 'daysAgo' ? null : arg; // for daysAgo the arg is the day count, not a format
    return fmt ? fmt.replace(/YYYY/g, Y).replace(/MM/g, M).replace(/DD/g, D) : `${Y}-${M}-${D}`;
  });
}
// A CAPTURED CONTEXT value (e.g. a DNI observed in a request URL), stored alongside auth in
// storage.session and exposed to templates as {ctx.<name>}. Mirrors {csrf}/{group.*}. Never on disk.
const ctxOf = (auth) => (auth && (auth.__ctx || auth.ctx)) || {};
const fillCtx = (str, auth) => { const ctx = ctxOf(auth); return String(str).replace(/\{ctx\.([^}]+)\}/g, (m, k) => (ctx[k] == null ? m : tid(ctx[k]))); };
// Fill a POST-body/URL template: {group.*} + {ctx.*} (captured context, e.g. the DNI) + {csrf} (the
// CSRF token from the prelude, on auth.__csrf) + any {paramName} from the request params (paging/range/
// date window). Values are URL-encoded (form-urlencoded body); for JSON bodies the values are alnum ids.
function fillTmpl(str, group, auth, params) {
  const ctx = ctxOf(auth);
  let s = tmplGroup(str, group).split('{csrf}').join((auth && auth.__csrf) || '');
  s = s.replace(/\{ctx\.([^}]+)\}/g, (m, k) => (ctx[k] == null ? m : String(ctx[k])));
  for (const k of Object.keys(params || {})) s = s.split('{' + k + '}').join(params[k] == null ? '' : String(params[k]));
  return s;
}
// Unified document-URL/body templater for a doc: {internalId} + {csrf} + {group.*} (doc._group, e.g. the
// card) + {field.path} (doc._raw, e.g. the statement's statementDate). Values are URL-encoded.
// Reformat a date value to a template's FORMAT (YYYY/MM/DD tokens). Parses ISO (2025-09-01), DD/MM/YYYY and
// YYYY/MM/DD; anything unrecognized is returned as-is. Lets a document endpoint state the exact shape it
// wants ({date:DD/MM/YYYY}) even though the stored/record date is normalized to ISO (a store re-download has
// no _raw, so {date} falls back to record.date = ISO — which some APIs reject as a validation error).
function fmtDateStr(v, fmt) {
  const s = String(v); let m;
  let y, mo, d;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) { y = m[1]; mo = m[2]; d = m[3]; }
  else if ((m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s))) { d = m[1]; mo = m[2]; y = m[3]; }
  else if ((m = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(s))) { y = m[1]; mo = m[2]; d = m[3]; }
  else return s;
  return fmt.replace(/YYYY/g, y).replace(/MM/g, mo).replace(/DD/g, d);
}
function fillDocTmpl(str, doc, id, csrf, auth) {
  const ctx = ctxOf(auth);
  // Only {word.word} tokens (internalId, csrf, ctx.*, group.*, field paths), each with an optional :FORMAT
  // (e.g. {date:DD/MM/YYYY}) — NOT arbitrary braces, so a GraphQL POST body (`{ receipt(x) { receiptPdf } }`)
  // keeps its own braces (they have spaces) and only real tokens fill.
  return String(str).replace(/\{([\w.]+)(?::([^}]+))?\}/g, (m, k, fmt) => {
    if (k === 'internalId') return tid(id);
    if (k === 'csrf') return csrf == null ? '' : String(csrf);
    if (k.indexOf('ctx.') === 0) { const v = ctx[k.slice(4)]; return v == null ? m : tid(v); }
    const isGroup = k.indexOf('group.') === 0;
    const rk = isGroup ? k.slice(6) : k;
    let v = isGroup ? (doc && doc._group ? get(doc._group, rk) : undefined) : (doc && doc._raw ? get(doc._raw, k) : undefined);
    // Store re-download of a synthetic doc: the transient _group/_raw are gone — recover the value from the
    // persisted record (and its keepRaw `extra`, which captured the group's derived fields + the period window).
    if (v == null && doc && doc.record) { v = get(doc.record, rk); if (v == null && doc.record.extra) v = get(doc.record.extra, rk); }
    return v == null ? m : tid(fmt ? fmtDateStr(v, fmt) : v);
  });
}
// Resolve a field mapping: a plain dotted path into the item, OR a template referencing {group.*}
// (and/or item fields) — e.g. account: "{group.iban}", internalId: "{group.id}-{transactionId}". A lone
// {x} preserves the raw value's type; a template with surrounding text interpolates to a string.
function resolveField(value, item, group) {
  if (typeof value !== 'string' || value.indexOf('{') < 0) return get(item, value);
  const pick = (k) => (k.indexOf('group.') === 0 ? (group ? get(group, k.slice(6)) : undefined) : get(item, k));
  const single = value.match(/^\{([^}]+)\}$/);
  if (single) return pick(single[1]);
  return value.replace(/\{([^}]+)\}/g, (m, k) => { const v = pick(k); return v == null ? '' : String(v); });
}

// Resolve the headers to replay for a given endpoint path from the captured auth STORE
// ({ byPath, merged }). Different endpoints can use different auth (e.g. cookie-authed list +
// bearer-authed PDF) — each replays what was captured for ITS path, falling back to the union.
// `allowMerged=false` (cookie endpoints) avoids leaking a bearer captured elsewhere.
function headersFor(auth, path, allowMerged = true) {
  if (!auth) return {};
  if (auth.byPath || auth.merged) {
    const exact = path && auth.byPath && auth.byPath[path];
    if (exact) return exact;
    return allowMerged ? (auth.merged || {}) : {};
  }
  return auth; // already a plain headers object (tests / direct callers)
}

// Which per-document artifact this source produces: a PDF (GET, or POST-generated) or a JSON detail
// (GET). JSON detail is preferred when present — it's the practical artifact for many services.
export function documentExt(adapter) {
  const pdf = adapter.api.pdf, detail = adapter.api.detail;
  if (detail && (detail.as === 'html' || detail.as === 'invoice' || detail.as === 'render')) return 'html'; // printable invoice
  if (pdf && (!pdf.method || pdf.method === 'GET')) return 'pdf';
  if (detail) return 'json';
  if (pdf) return 'pdf';
  return null;
}

// A clean, self-contained, printable HTML invoice generated from the receipt's detail JSON + record.
// Cross-browser (no external assets, no tab render); the user prints it to PDF. All values escaped.
function flattenRows(obj, prefix, depth, rows) {
  rows = rows || []; depth = depth || 0;
  if (obj == null || typeof obj !== 'object' || depth > 4) return rows;
  for (const k of Object.keys(obj)) {
    const v = obj[k], key = prefix ? prefix + ' · ' + k : k;
    if (v && typeof v === 'object') {
      if (Array.isArray(v) && v.every((x) => x == null || typeof x !== 'object')) rows.push([key, v.join(', ')]);
      else flattenRows(v, key, depth + 1, rows);
    } else if (v !== '' && v != null) rows.push([key, v]);
  }
  return rows;
}
// Resolve {dotted.path} tokens in a template string against the detail JSON (missing → empty).
function resolveTpl(str, data) {
  return String(str == null ? '' : str).replace(/\{([\w.]+)\}/g, (_, p) => { const v = get(data, p); return v == null ? '' : String(v); });
}
const INVOICE_CSS = `body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:720px;margin:40px auto;color:#1a1a1a;padding:0 20px;font-size:14px}
h1{font-size:20px;margin:0 0 2px} h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#888;margin:22px 0 6px;font-weight:600}
.brand{color:#888;font-size:12px;margin-bottom:14px} .meta{color:#555;margin-bottom:6px;display:flex;gap:18px;flex-wrap:wrap} .meta .k{color:#999}
.block div{line-height:1.5} table{border-collapse:collapse;width:100%} td{padding:6px 4px;vertical-align:top}
table.items td{border-bottom:1px solid #eee} table.totals td{padding:4px} .num{text-align:right;white-space:nowrap}
table.totals tr.grand td{border-top:2px solid #222;font-weight:700;font-size:16px;padding-top:8px} td.k{color:#888;width:38%}
@media print{body{margin:0}}`;
export function renderInvoiceHtml(doc, detail, adapter) {
  const r = (doc && doc.record) || doc || {};
  const brand = escH(adapter.name || adapter.service || '');
  const tmpl = adapter && adapter.api && adapter.api.detail && adapter.api.detail.template;
  if (tmpl) {
    // Declarative receipt: layout lives in the adapter (data), values + labels resolved from the detail JSON
    // (the source's own i18n labels, e.g. AliExpress mcms.*). All values HTML-escaped.
    const T = (s) => escH(resolveTpl(s, detail));
    const lines = (arr) => (arr || []).map((s) => resolveTpl(s, detail)).filter((x) => x && x.trim());
    const meta = (tmpl.meta || []).map((m) => resolveTpl(m.value, detail) ? `<div><span class="k">${T(m.label)}</span> ${T(m.value)}</div>` : '').join('');
    const blocks = (tmpl.blocks || []).map((b) => { const ls = lines(b.lines).map((x) => `<div>${escH(x)}</div>`).join(''); return ls ? `<section class="block"><h2>${T(b.title)}</h2>${ls}</section>` : ''; }).join('');
    let items = '';
    if (tmpl.items) {
      const arr = get(detail, tmpl.items.from);
      const rows = (Array.isArray(arr) ? arr : []).map((it) => `<tr>${(tmpl.items.cols || []).map((c, i) => `<td${i ? ' class="num"' : ''}>${escH(resolveTpl(c.value, it))}</td>`).join('')}</tr>`).join('');
      if (rows) items = `<section class="block"><h2>${T(tmpl.items.title)}</h2><table class="items">${rows}</table></section>`;
    }
    const totals = (tmpl.totals || []).map((t, i, a) => { const v = resolveTpl(t.value, detail); return v ? `<tr class="${i === a.length - 1 ? 'grand' : ''}"><td>${T(t.label)}</td><td class="num">${escH(v)}</td></tr>` : ''; }).join('');
    const title = T(tmpl.title) || brand;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${INVOICE_CSS}</style></head><body>
      <h1>${title}</h1><div class="brand">${brand}${tmpl.subtitle ? ' · ' + T(tmpl.subtitle) : ''}</div>
      <div class="meta">${meta}</div>${blocks}${items}
      ${totals ? `<section class="block"><table class="totals">${totals}</table></section>` : ''}
    </body></html>`;
  }
  // Generic fallback: a flat key/value table of the whole detail JSON.
  const rows = flattenRows(detail).slice(0, 200).map(([k, v]) => `<tr><td class="k">${escH(k)}</td><td>${escH(v)}</td></tr>`).join('');
  const title = `${adapter.name || adapter.service} — ${r.number || (doc && doc.internalId) || ''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escH(title)}</title><style>${INVOICE_CSS}</style></head><body>
    <h1>${escH(adapter.name || adapter.service)}</h1>
    <div class="meta">${r.number ? 'Nº ' + escH(r.number) : ''}${r.date ? ' · ' + escH(r.date) : ''}</div>
    ${r.total != null && r.total !== '' ? `<div class="total">${escH(r.total)} ${escH(r.currency || '')}</div>` : ''}
    <table>${rows}</table>
  </body></html>`;
}

// Two artifact kinds per document: `data` (the structured JSON detail) and `document` (the
// presentable file — rendered/print HTML or PDF). A source can produce either or BOTH; a sink chooses
// which to take (sink.accepts.artifacts). `api.detail` (plain) = data; `api.document` (as:render|
// html|invoice) or `api.pdf` = document; a legacy `api.detail.as` counts as the document.
const docExtOf = (cfg) => (cfg.as === 'render' || cfg.as === 'html' || cfg.as === 'invoice' ? 'html' : 'pdf');
const documentCfg = (api) => api.document || (api.detail && api.detail.as ? api.detail : null);
// True unless a {field.path} placeholder (other than {internalId}) is missing from this doc's raw item.
// Lets a per-doc-conditional artifact (Dia's invoice PDF needs {invoices.0}) be skipped for docs that
// don't have it (a ticket with no invoice) instead of firing a malformed request.
function tmplResolvable(str, doc) {
  // Only {word.word} tokens are templates (matches fillDocTmpl); a JSON body's own braces ({"from":…}) are not.
  for (const m of String(str || '').matchAll(/\{([\w.]+)\}/g)) {
    const k = m[1];
    if (k === 'internalId' || k === 'csrf' || k.indexOf('ctx.') === 0) continue; // always available at fetch time
    const isGroup = k.indexOf('group.') === 0;
    const rk = isGroup ? k.slice(6) : k;
    let v = isGroup ? (doc && doc._group ? get(doc._group, rk) : undefined) : (doc && doc._raw ? get(doc._raw, k) : undefined);
    // Match fillDocTmpl: a doc loaded from the store has no _group/_raw but its persisted record (+ keepRaw
    // `extra`) carries the same values, so the artifact is still resolvable.
    if (v == null && doc && doc.record) { v = get(doc.record, rk); if (v == null && doc.record.extra) v = get(doc.record.extra, rk); }
    if (v == null || v === '') return false;
  }
  return true;
}
// Which artifacts this source produces. With a `doc`, drops any document whose template fields the doc
// can't fill (e.g. a Dia ticket without an associated invoice) — no artifact, no error.
export function artifactKinds(adapter, doc) {
  const api = adapter.api || {}, out = [];
  if (api.detail && !api.detail.as) out.push({ kind: 'data', ext: 'json' });
  const dc = documentCfg(api);
  if (dc) { if (!doc || tmplResolvable(dc.path, doc)) out.push({ kind: 'document', ext: docExtOf(dc) }); }
  else if (api.pdf) {
    // urlField: the document is an absolute URL on the list item — available iff that field is present on
    // the raw item, OR (a row loaded from the store, no `_raw`) it was persisted as `record.pdfUrl`.
    const ok = api.pdf.urlField
      ? (!doc || (doc._raw && get(doc._raw, api.pdf.urlField) != null && get(doc._raw, api.pdf.urlField) !== '') || !!(doc.record && doc.record.pdfUrl))
      : api.pdf.poll // async-generated (Revolut statements): the poll path is what must be fillable
        ? (!doc || tmplResolvable(api.pdf.poll.path, doc))
        : api.pdf.job // async job export (Trade Republic CSV): the start path/body is what must be fillable
          ? (!doc || (tmplResolvable(api.pdf.job.start.path, doc) && tmplResolvable(api.pdf.job.start.body || '', doc)))
          : (!doc || tmplResolvable(api.pdf.path, doc));
    if (ok) out.push({ kind: 'document', ext: api.pdf.ext || 'pdf' });
  }
  return out;
}
// Fetch one artifact. Reuses fetchDocument by PROJECTING the adapter so the requested artifact sits
// on api.detail/api.pdf (no change to the low-level fetchers).
export async function fetchArtifact(adapter, auth, doc, net, render, kind) {
  const api = adapter.api;
  if (kind === 'data') {
    const a = { ...adapter, api: { ...api, detail: api.detail, pdf: undefined, document: undefined } };
    const r = await fetchDocument(a, auth, doc, net, render);
    return { kind, ext: 'json', blob: r.blob, via: r.via };
  }
  const dc = documentCfg(api);
  const a = dc ? { ...adapter, api: { ...api, detail: dc, pdf: undefined } } : { ...adapter, api: { ...api, detail: undefined } };
  const r = await fetchDocument(a, auth, doc, net, render);
  return { kind, ext: r.ext, blob: r.blob, via: r.via };
}

// Fetch a document's file (PDF or JSON detail) as a Blob. Accepts a doc object (preferred — carries
// `_raw`) or a bare internalId. `detail.from:'list'` uses the already-listed item's JSON as the
// document (no extra request) — ideal when the list endpoint already returns each order's data and
// there is no safe per-item endpoint. Otherwise: GET-PDF, then JSON detail, then POST-PDF.
export async function fetchDocument(adapter, auth, docOrId, net, render) {
  const doc = docOrId && typeof docOrId === 'object' ? docOrId : null;
  const internalId = doc ? doc.internalId : docOrId;
  const detail = adapter.api.detail;
  if (detail && detail.from === 'list') {
    const data = doc ? (doc._raw != null ? doc._raw : doc.record || {}) : {};
    return { blob: new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), ext: 'json', via: 'list' };
  }
  if (detail && detail.as === 'render') { // render the SPA page in a tab, capture the FINAL DOM, self-contain it
    if (!render) throw new Error('rendering needs a tab — open the site and retry');
    const host = detail.host ? absHost(detail.host) : adapter.api.host;
    const url = host + detail.path.split('{internalId}').join(tid(internalId));
    const html = await inlineAssets(await render(url, { waitFor: detail.waitFor, waitMs: detail.waitMs }), url, net || ((u, i) => fetch(u, i)));
    return { blob: new Blob([html], { type: 'text/html' }), ext: 'html', via: 'render' };
  }
  if (detail && detail.as === 'html') return fetchHtmlDoc(adapter, auth, internalId, net); // fetch the print page, self-contained
  if (detail && detail.as === 'invoice') { // render a clean printable invoice from the detail JSON
    const dj = await fetchDetail(adapter, auth, doc || internalId, net);
    let data = {}; try { data = JSON.parse(await dj.blob.text()); } catch (e) {}
    return { blob: new Blob([renderInvoiceHtml(doc || { internalId }, data, adapter)], { type: 'text/html' }), ext: 'html', via: 'invoice' };
  }
  const ext = documentExt(adapter);
  if (ext === 'pdf') return { blob: await fetchPdf(adapter, auth, doc || internalId, net), ext: adapter.api.pdf.ext || 'pdf', via: 'pdf' };
  if (ext === 'json') return { ...(await fetchDetail(adapter, auth, doc || internalId, net)), ext };
  throw new Error('no document for this source');
}

// Decode a (possibly data-URI-prefixed) base64 string into a Blob — for documents delivered inside a
// JSON field rather than as a raw binary response (see api.pdf.base64Field).
function base64ToBlob(b64, mime) {
  const clean = String(b64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function fetchPdf(adapter, auth, docOrId, net) {
  const NET = netFetch(net, adapter && adapter.throttle);
  const doc = docOrId && typeof docOrId === 'object' ? docOrId : null;
  const internalId = doc ? doc.internalId : docOrId;
  const pdf = adapter.api.pdf;
  if (!pdf) throw new Error('no PDF for this source');
  const host = pdf.host ? absHost(pdf.host) : adapter.api.host;
  // WiZink's securityToken is single-use/short-lived — the prelude token is stale by download time.
  // Refresh it right before each document fetch so the download carries a valid {csrf}.
  let csrf = auth && auth.__csrf;
  if (adapter.api.csrf) { try { csrf = await fetchCsrf(adapter, auth, net); } catch (e) {} }
  // Async-generated document (Revolut statements): a `prepare` endpoint kicks off generation and returns
  // {state}; poll it until `readyValue`, read the signed download URL out of the READY response, then GET
  // that URL (typically a cross-domain object store — guarded by crossDomainHosts + consent, fetched with
  // no auth/cookies since the URL is itself signed).
  if (pdf.poll) {
    const pl = pdf.poll;
    const pollPath = fillDocTmpl(pl.path, doc, internalId, csrf, auth);
    if (/\{[^}]+\}/.test(pollPath)) throw new Error('no document for this item'); // unfillable → skip cleanly
    let url = null;
    for (let i = 0; i < (pl.tries || 8); i++) {
      const res = await NET(host + pollPath, { method: 'GET', headers: { accept: 'application/json', ...(pl.headers || {}), ...headersFor(auth, pollPath.split('?')[0]) }, credentials: credOf(adapter) });
      if (!res.ok) throw new Error('statement ' + res.status + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
      const j = JSON.parse(await res.text());
      if (String(get(j, pl.statePath || 'state')) === String(pl.readyValue ?? 'READY')) { url = get(j, pl.urlField || 'url'); break; }
      if (i < (pl.tries || 8) - 1) await new Promise((r) => setTimeout(r, pl.delayMs || 1200)); // still generating → wait, poll again
    }
    if (url == null || url === '') throw new Error('statement not ready (still generating)');
    assertAllowedDocHost(adapter, String(url)); // the signed URL's host must be an allowed (crossDomain) host
    const dRes = await NET(String(url), { method: 'GET', headers: { accept: '*/*' }, credentials: 'omit', wantBlob: true }); // signed URL: no cookies/auth
    if (!dRes.ok) throw new Error('statement download ' + dRes.status);
    return await dRes.blob();
  }
  // Async JOB export (Trade Republic CSV): POST a `start` request → get a jobId → poll a `status` endpoint by
  // jobId until ready → GET the `download` endpoint by jobId. All same-origin (unlike poll's signed URL).
  if (pdf.job) {
    const jb = pdf.job;
    const startPath = fillDocTmpl(jb.start.path, doc, internalId, csrf, auth);
    const startBody = jb.start.body != null ? fillDocTmpl(jb.start.body, doc, internalId, csrf, auth) : undefined;
    if (/\{[\w.]+\}/.test(startPath) || (startBody && /\{[\w.]+\}/.test(startBody))) throw new Error('no document for this item'); // leftover {token} → unfillable (JSON braces are fine)
    const sInit = { method: jb.start.method || 'POST', headers: { accept: 'application/json', ...(jb.start.headers || {}), ...headersFor(auth, startPath.split('?')[0]) }, credentials: credOf(adapter) };
    if (startBody != null) { sInit.body = startBody; sInit.headers['content-type'] = jb.start.contentType || 'application/json'; }
    const sRes = await NET(host + startPath, sInit);
    if (!sRes.ok) throw new Error('export ' + sRes.status + ' ' + (await sRes.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
    const jobId = get(JSON.parse(await sRes.text()), jb.start.idField || 'jobId');
    if (jobId == null || jobId === '') throw new Error('export: no job id');
    const fill = (p) => String(p).split('{jobId}').join(encodeURIComponent(String(jobId)));
    let ready = false;
    for (let i = 0; i < (jb.status.tries || 10); i++) {
      const stRes = await NET(host + fill(jb.status.path), { method: 'GET', headers: { accept: 'application/json', ...headersFor(auth, fill(jb.status.path).split('?')[0]) }, credentials: credOf(adapter) });
      if (!stRes.ok) throw new Error('export status ' + stRes.status);
      if (String(get(JSON.parse(await stRes.text()), jb.status.statePath || 'status')) === String(jb.status.readyValue ?? 'COMPLETED')) { ready = true; break; }
      if (i < (jb.status.tries || 10) - 1) await new Promise((r) => setTimeout(r, jb.status.delayMs || 1000));
    }
    if (!ready) throw new Error('export not ready (still generating)');
    const dRes = await NET(host + fill(jb.download.path), { method: 'GET', headers: { accept: '*/*', ...headersFor(auth, fill(jb.download.path).split('?')[0]) }, credentials: credOf(adapter), wantBlob: true });
    if (!dRes.ok) throw new Error('export download ' + dRes.status);
    return await dRes.blob();
  }
  // Two-step document resolution: some services don't expose a stable PDF URL — the detail/list only
  // links a small resolver page (e.g. Amazon's invoice popover) that in turn carries the real, opaque
  // document URL. Fetch the resolver, regex its TEXT for the link (capture group 1), guard the host,
  // then GET the document. A non-match = no document for this order (callers fall back to metadata-only).
  if (pdf.resolve) {
    const r = pdf.resolve;
    const rPath = fillDocTmpl(r.path, doc, internalId, csrf, auth);
    if (/\{[^}]+\}/.test(rPath)) throw new Error('no document for this item'); // unfillable → skip cleanly
    const rInit = { method: r.method || 'GET', headers: { accept: 'text/html,*/*', ...(r.headers || {}), ...headersFor(auth, rPath.split('?')[0]) }, credentials: credOf(adapter) };
    const rRes = await NET(host + rPath, rInit);
    if (!rRes.ok) throw new Error('resolve ' + rRes.status + ' ' + (await rRes.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
    const m = new RegExp(r.linkMatch, 'i').exec(await rRes.text());
    if (!m || m[1] == null) throw new Error('no document for this item'); // no invoice link → metadata-only
    let docUrl = m[1].replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(docUrl)) docUrl = adapter.api.host + (docUrl[0] === '/' ? docUrl : '/' + docUrl); // relative → same origin
    assertAllowedDocHost(adapter, docUrl); // the URL came from HTML — enforce it stays on the source's domain
    let dPath; try { dPath = new URL(docUrl).pathname; } catch (e) { dPath = docUrl; }
    const dRes = await NET(docUrl, { method: 'GET', headers: { accept: '*/*', ...headersFor(auth, dPath) }, credentials: credOf(adapter), wantBlob: true });
    if (!dRes.ok) throw new Error('pdf ' + dRes.status + ' ' + (await dRes.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
    return await dRes.blob();
  }
  let url, path;
  if (pdf.urlField) {
    // ABSOLUTE-URL document: the list item already carries the full https:// link to the file (e.g.
    // CaixaBank's statement `Url`). Fetch it verbatim — but keep the same-domain guard honest: the
    // URL's host MUST be the source's own domain or a declared crossDomainHosts entry.
    // From the raw list item, or — for a row loaded from the store (no `_raw`) — the persisted record.pdfUrl.
    const abs = (doc && doc._raw ? get(doc._raw, pdf.urlField) : undefined) || (doc && doc.record ? doc.record.pdfUrl : undefined);
    if (!abs || !/^https:\/\//i.test(String(abs))) throw new Error('no document for this item');
    assertAllowedDocHost(adapter, String(abs)); // re-validate EVERY time — a persisted/imported URL isn't trusted
    url = String(abs);
    try { path = new URL(url).pathname; } catch (e) { path = url.split('?')[0]; }
  } else {
    path = fillDocTmpl(pdf.path, doc, internalId, csrf, auth); // {internalId} + {field.path} + {group.*} + {ctx.*} + {csrf}
    // A leftover {field} means this doc can't fill the template (e.g. a ticket with no invoice) — no
    // document for it. Bail cleanly (callers treat it as "artifact unavailable") instead of a bad request.
    if (/\{[^}]+\}/.test(path)) throw new Error('no document for this item');
    url = host + path;
  }
  // accept:*/* not application/pdf — some servers (Dia's invoice endpoint) return 204 No Content for a
  // bare application/pdf Accept but serve the real PDF for the browser-default */*.
  // base64Field: the document comes back INSIDE a JSON response (e.g. IKEA's GraphQL
  // `data.receipt.receiptPdf` holds the PDF base64-encoded) — read JSON, not a blob.
  const wantBlob = !pdf.base64Field;
  // pdf.headers may carry {group.*} (RAW, like list.headers — a per-card encrypted-PAN header must not be
  // URL-encoded), so a document endpoint that needs the card's own header (FECI statements) can send it.
  const phdr = {}; for (const k of Object.keys(pdf.headers || {})) phdr[k] = tmplGroupRaw(pdf.headers[k], doc && doc._group);
  const init = { method: pdf.method || 'GET', headers: { accept: wantBlob ? '*/*' : 'application/json', ...phdr, ...headersFor(auth, path.split('?')[0]) }, credentials: credOf(adapter), wantBlob };
  if (init.method !== 'GET' && pdf.body != null) {
    init.body = fillDocTmpl(pdf.body, doc, internalId, csrf, auth);
    init.headers['content-type'] = pdf.contentType || 'application/json';
  }
  const referer = pdf.referer ? fillDocTmpl(pdf.referer, doc, internalId, csrf, auth) : null;
  const res = await withReferer(url, referer, () => NET(url, init));
  if (!res.ok) {
    const hint = res.status === 406 ? ' (sin PDF disponible — típico en tickets antiguos)' : '';
    throw new Error('pdf ' + res.status + hint + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
  }
  if (pdf.base64Field) {
    const j = JSON.parse(await res.text());
    const b64 = get(j, pdf.base64Field);
    if (b64 == null || b64 === '') throw new Error('no document for this item'); // e.g. an online order with no receipt
    return base64ToBlob(String(b64), pdf.mime || 'application/pdf');
  }
  return await res.blob();
}

const EMBED_RES = [
  /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i,
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i,
  /window\.__NUXT__\s*=\s*([\s\S]*?);?\s*<\/script>/i,
  /window\.__INITIAL_STATE__\s*=\s*([\s\S]*?);?\s*<\/script>/i,
];
const stripTags = (s) => (s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

// Parse HTML tables / definition lists into JSON (case: data rendered directly in a table).
function parseTables(html) {
  const out = [];
  for (const tbl of html.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const rows = (tbl.match(/<tr[\s\S]*?<\/tr>/gi) || []).map((tr) => (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags)).filter((r) => r.some((c) => c));
    if (!rows.length) continue;
    if (rows.every((r) => r.length === 2)) { const o = {}; for (const [k, v] of rows) if (k) o[k] = v; out.push(o); }
    else { const head = rows[0]; out.push(rows.slice(1).map((r) => { const o = {}; head.forEach((h, i) => { if (h) o[h] = r[i]; }); return o; })); }
  }
  const dl = [...html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)];
  if (dl.length) { const o = {}; for (const m of dl) { const k = stripTags(m[1]); if (k) o[k] = stripTags(m[2]); } out.push(o); }
  return out.length ? out : null;
}

const nodeSize = (v) => { if (v == null || typeof v !== 'object') return 1; let n = 1; for (const k in v) n += nodeSize(v[k]); return n; };

// Server-rendered/AJAX payloads often carry the WHOLE app state (every purchase). Narrow to the ONE
// document: the richest object that either has the id as a direct property value, or is stored under
// a key === the id (a map keyed by id). Falls back to the whole payload if the id isn't found.
export function pickDetailById(root, id) {
  if (id == null || root == null || typeof root !== 'object') return root;
  const idStr = String(id);
  let best = null, bestSize = -1;
  const consider = (node) => { if (node && typeof node === 'object' && !Array.isArray(node)) { const s = nodeSize(node); if (s > bestSize) { bestSize = s; best = node; } } };
  const visit = (node) => {
    if (node == null || typeof node !== 'object') return;
    if (!Array.isArray(node)) {
      if (Object.keys(node).some((k) => { const v = node[k]; return v != null && typeof v !== 'object' && String(v) === idStr; })) consider(node);
      if (Object.prototype.hasOwnProperty.call(node, idStr)) consider(node[idStr]);
    }
    for (const k in node) visit(node[k]);
  };
  visit(root);
  return best || root;
}

// Detect HOW the detail delivers its data and return the extracted JSON (narrowed to `id`) + the
// mechanism: 'json' (AJAX/API), 'embedded' (JSON in the page HTML), 'table' (HTML table), 'html'.
export function extractDetail(text, url, id) {
  const t = (text || '').trim();
  let parsed, via;
  if (t[0] === '{' || t[0] === '[') { try { parsed = JSON.parse(t); via = 'json'; } catch (e) {} }
  if (parsed === undefined) {
    for (const re of EMBED_RES) { const m = re.exec(text || ''); if (m) { try { parsed = JSON.parse(m[1].trim()); via = 'embedded'; break; } catch (e) {} } }
  }
  if (parsed !== undefined) return { json: JSON.stringify(id != null ? pickDetailById(parsed, id) : parsed), via };
  const tables = parseTables(text || '');
  if (tables) return { json: JSON.stringify(tables.length === 1 ? tables[0] : tables), via: 'table' };
  return { json: JSON.stringify({ _url: url, _html: (text || '').slice(0, 300000) }), via: 'html' };
}

// Per-document JSON detail (an order's full data). Detects the delivery mechanism (AJAX JSON /
// embedded JSON / HTML table) and returns { blob, via }.
// Fetch an HTML document (e.g. hover's server-rendered receipt/print page) and make it self-contained:
// inline its stylesheets and images so it renders offline and prints to PDF anywhere (cross-browser,
// no tab render). A <base> covers anything not inlined.
async function toDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(s)}`;
}
async function inlineAssets(html, baseUrl, NET) {
  let base; try { base = new URL(baseUrl); } catch (e) { return html; }
  const abs = (u) => { try { return new URL(u, base).href; } catch (e) { return null; } };
  let budget = 25; // cap fetched assets
  for (const m of [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)]) {
    if (budget-- <= 0) break;
    const href = (m[0].match(/href=["']([^"']+)["']/i) || [])[1]; const u = href && abs(href);
    if (!u) continue;
    try { const css = await (await NET(u, { credentials: 'include' })).text(); html = html.replace(m[0], `<style>${css}</style>`); } catch (e) {}
  }
  for (const m of [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]) {
    if (budget-- <= 0) break;
    const u = abs(m[1]); if (!u || /^data:/i.test(m[1])) continue;
    try { const du = await toDataUrl(await (await NET(u, { credentials: 'include', wantBlob: true })).blob()); html = html.split('"' + m[1] + '"').join('"' + du + '"').split("'" + m[1] + "'").join("'" + du + "'"); } catch (e) {}
  }
  if (!/<base\b/i.test(html)) html = html.replace(/<head\b[^>]*>/i, (h) => h + `<base href="${base.origin}/">`);
  return html;
}
async function fetchHtmlDoc(adapter, auth, internalId, net) {
  const NET = netFetch(net, adapter && adapter.throttle);
  const d = adapter.api.detail;
  const host = d.host ? absHost(d.host) : adapter.api.host;
  const path = d.path.split('{internalId}').join(tid(internalId));
  const url = host + path;
  const init = { headers: { accept: 'text/html', ...(d.headers || {}), ...headersFor(auth, path.split('?')[0]) }, credentials: credOf(adapter) };
  const referer = d.referer ? String(d.referer).split('{internalId}').join(internalId) : null;
  if (referer) init.referrer = referer;
  const res = await withReferer(url, referer, () => NET(url, init));
  if (!res.ok) throw new Error('detail ' + res.status + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
  const html = await inlineAssets(await res.text(), url, NET);
  return { blob: new Blob([html], { type: 'text/html' }), ext: 'html', via: 'page' };
}

// Content of a page region marked `data-component="NAME"` (Amazon order-details), from just after the
// marker to the next data-component boundary. A coarse, non-nesting slice — fine for the leaf regions we
// read (orderDate/orderId/…); scope a field to a region via {region:"NAME"} to avoid cross-matching.
function componentRegion(html, name) {
  const m = new RegExp('data-component=["\']' + escapeRe(name) + '["\']').exec(html || '');
  if (!m) return '';
  const rest = String(html).slice(m.index + m[0].length);
  const nxt = rest.search(/data-component=["']/);
  return nxt < 0 ? rest : rest.slice(0, nxt);
}
// Build a structured JSON record from an order-details HTML page using declarative field extractors —
// the SAME re/attr/tag/sel vocabulary as list rows (extractField). A field may set `region:"NAME"` to
// scope extraction to a data-component block first. `detail.items` (each+fields) captures the repeated
// line-items; `detail.const` merges constant fields (e.g. currency). date/total/amount are normalized
// like a mapped doc (ISO date, numeric amount). Used when api.detail declares `fields`; else the
// auto-detecting extractDetail path is used (full back-compat).
export function extractDetailFields(html, cfg) {
  const rec = { ...(cfg.const || {}) };
  for (const k of Object.keys(cfg.fields || {})) {
    const f = cfg.fields[k];
    rec[k] = extractField(f.region ? componentRegion(html, f.region) : (html || ''), f);
  }
  if (cfg.items) rec.items = parseHtmlItems(html || '', cfg.items);
  if (rec.date != null && rec.date !== '') rec.date = normalizeDate(rec.date);
  for (const k of ['total', 'amount', 'refundTotal']) if (typeof rec[k] === 'string' && rec[k] !== '') rec[k] = normalizeAmount(rec[k]);
  if (Array.isArray(rec.items)) for (const it of rec.items) for (const k of ['price', 'amount', 'total']) if (typeof it[k] === 'string' && it[k] !== '') it[k] = normalizeAmount(it[k]);
  return rec;
}

export async function fetchDetail(adapter, auth, docOrId, net) {
  const NET = netFetch(net, adapter && adapter.throttle);
  const doc = docOrId && typeof docOrId === 'object' ? docOrId : null;
  const internalId = doc ? doc.internalId : docOrId;
  const d = adapter.api.detail;
  if (!d) throw new Error('no detail for this source');
  // mtop detail (AliExpress receipt): a single component call with a KNOWN flat payload built from the
  // doc — no captured seed needed (unlike the list). The page's lib.mtop signs it.
  if (d.mtop) {
    const mtopFn = net && net.mtop;
    if (!mtopFn) throw new Error('detail mtop — no mtop transport (open the site tab first)');
    const params = {};
    for (const k of Object.keys(d.params || {})) params[k] = applyTmpl(String(d.params[k]), doc, internalId);
    const res = await mtopFn({ ...d.mtop, data: params });
    if (res && res.error) throw new Error('detail mtop — ' + res.error);
    const page = (res && res.pages && res.pages[0]) || {};
    const data = d.dataPath ? get(page, d.dataPath) : page;
    return { blob: new Blob([JSON.stringify(data == null ? {} : data)], { type: 'application/json' }), via: 'mtop' };
  }
  const host = d.host ? absHost(d.host) : adapter.api.host;
  const path = applyTmpl(d.path, doc, internalId); // {internalId} + {field.path} from the list item
  const url = host + path;
  // d.headers: static headers the SPA sends for this endpoint (e.g. dkt-ecom-origin). Captured auth
  // and the accept default fill the rest; cookies ride along via credentials:'include'.
  const init = { method: d.method || 'GET', headers: { accept: 'application/json, text/html', ...(d.headers || {}), ...headersFor(auth, path.split('?')[0]) }, credentials: credOf(adapter) };
  // d.referer: some endpoints validate the Referer (e.g. the item's detail page). fetch can't set it
  // (forbidden header) → declarativeNetRequest, same as the PDF path.
  const referer = d.referer ? applyTmpl(d.referer, doc, internalId) : null;
  if (referer) init.referrer = referer; // page-context fetch sets it same-origin (reliable); DNR is the fallback
  const res = await withReferer(url, referer, () => NET(url, init));
  if (!res.ok) throw new Error('detail ' + res.status + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
  const text = await res.text();
  // Declarative HTML → JSON: when the detail declares field extractors, parse the record from the page
  // HTML (Amazon order-details has no embedded JSON to narrow). Otherwise auto-detect (JSON/embedded/table).
  if (d.fields) return { blob: new Blob([JSON.stringify(extractDetailFields(text, d))], { type: 'application/json' }), via: 'html-fields' };
  const { json, via } = extractDetail(text, url, internalId);
  return { blob: new Blob([json], { type: 'application/json' }), via };
}

// Session keep-alive. Some sessions expire fast (Openbank's token lives ~300s) and a long paged listing or
// a multi-source sweep can outlast it. A source declares `keepAlive { path, method, everyMs, tokenField }`;
// the runtime pings it at most once per `everyMs` (per host) DURING paging, and — when the response returns
// a fresh token (`tokenField`) — swaps it into the in-memory auth (merged + every byPath entry) so the rest
// of the operation keeps authenticating. Best-effort: a keep-alive failure never aborts the listing.
const KA_LAST = new Map(); // host → last keep-alive ms
async function maybeKeepAlive(adapter, auth, net) {
  const ka = adapter && adapter.keepAlive;
  if (!ka || !ka.path || !auth) return;
  const host = (adapter.api && adapter.api.host) || '';
  const now = Date.now();
  if (now - (KA_LAST.get(host) || 0) < (ka.everyMs || 120000)) return;
  KA_LAST.set(host, now);
  try {
    const NET = netFetch(net, null); // never throttle the keep-alive
    const method = (ka.method || 'POST').toUpperCase();
    const cookie = adapter.auth && adapter.auth.mode === 'cookie';
    const init = { method, headers: { accept: 'application/json', ...(ka.headers || {}), ...headersFor(auth, ka.path.split('?')[0], true /*allow captured replay headers (cookie sources only ever capture replayHeaders like x-device-id, never a token)*/) }, credentials: credOf(adapter) };
    if (method !== 'GET') { if (ka.body != null) init.body = ka.body; if (ka.contentType) init.headers['content-type'] = ka.contentType; }
    const res = await NET(host + ka.path, init);
    if (res.ok && ka.tokenField) {
      const j = await res.json().catch(() => null);
      const tok = j && get(j, ka.tokenField);
      if (tok) {
        const th = ((adapter.auth && adapter.auth.tokenHeader) || 'authorization').toLowerCase();
        if (auth.merged && auth.merged[th] != null) auth.merged[th] = tok;
        if (auth.byPath) for (const p of Object.keys(auth.byPath)) if (auth.byPath[p] && auth.byPath[p][th] != null) auth.byPath[p][th] = tok;
      }
    }
  } catch (e) { /* keep-alive is best-effort; listing continues on the existing token */ }
}

// Follow a full-URL next-page link (some APIs return `_links.nextPage.href`, a complete URL that already
// carries every pagination param, instead of a bare cursor token). The href is fetched verbatim —
// normalised to https (a capture/proxy may echo http:80) and re-checked against the same-domain guard so a
// tampered link can never redirect the authenticated session off the source's own domain.
async function fetchAbsList(adapter, auth, rawUrl, net) {
  let u = String(rawUrl).replace(/^http:\/\//i, 'https://').replace(/:80(?=[/?]|$)/, '');
  assertAllowedDocHost(adapter, u);
  const NET = netFetch(net, adapter && adapter.throttle);
  let pth; try { pth = new URL(u).pathname; } catch (e) { pth = u.split('?')[0]; }
  const cookie = adapter.auth && adapter.auth.mode === 'cookie';
  const list = adapter.api.list || {};
  const init = { method: 'GET', headers: { accept: 'application/json', ...(list.headers || {}), ...headersFor(auth, pth, true /*allow captured replay headers (cookie sources only ever capture replayHeaders like x-device-id, never a token)*/) }, credentials: credOf(adapter) };
  const res = await NET(u, init);
  if (!res.ok) throw new Error('list ' + res.status + ' — ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160));
  return await res.json();
}

async function fetchList(adapter, auth, params, net, group) {
  const NET = netFetch(net, adapter && adapter.throttle);
  const list = adapter.api.list;
  const html = list.from === 'html';
  // {group.*} in the list path / param values / referer → the account (group) currently being listed.
  // {today}/{monthStart}/{monthEnd}[:FORMAT] → computed calendar dates (e.g. a statement list's ?date_bill).
  const path = tmplDates(tmplGroup(list.path, group));
  const gparams = {}; for (const k of Object.keys(params || {})) gparams[k] = tmplDates(tmplGroup(params[k], group));
  const qs = new URLSearchParams(gparams).toString();
  const url = adapter.api.host + path + (qs ? '?' + qs : '');
  // Run in the site's tab (page context) so cookies + cf_clearance + fingerprint carry through and
  // Cloudflare/Akamai don't challenge it; credentials:'include' carries cookies.
  const cookie = adapter.auth && adapter.auth.mode === 'cookie';
  // A bare `accept: text/html` can trip content negotiation (Dia returns 204 No Content for it); send the
  // full browser navigation Accept so the server serves the real SSR page.
  const htmlAccept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  const method = (list.method || 'GET').toUpperCase();
  // Per-group header values: {group.*} templated so e.g. a card's own encrypted-PAN header rides its list.
  const gheaders = {}; for (const k of Object.keys(list.headers || {})) gheaders[k] = tmplGroupRaw(list.headers[k], group);
  const init = { method, headers: { accept: html ? htmlAccept : 'application/json', ...gheaders, ...headersFor(auth, path.split('?')[0], true /*allow captured replay headers (cookie sources only ever capture replayHeaders like x-device-id, never a token)*/) }, credentials: credOf(adapter) };
  // POST list (AEM/WiZink send params in the body; CaixaBank posts a JSON body with a date window):
  // fill {group.*} + {ctx.*} + {csrf} + {paramName} + the {fromDate}/{toDate} window (from list.window).
  if (method === 'POST' && list.body != null) {
    init.body = fillTmpl(list.body, group, auth, { ...gparams, ...bodyDates(list) });
    init.headers['content-type'] = list.contentType || 'application/x-www-form-urlencoded';
  }
  // list.referer: some endpoints only honour the offset/page when the Referer reflects the page the
  // SPA was on. Template it per request with {from}/{offset}/{page} (+ {group.*}); set via DNR (fetch can't).
  let referer = null;
  if (list.referer) {
    const off = Number(params[list.offsetParam] ?? params[list.pageParam] ?? 0);
    const size = Number(params.size || params.count || list.offsetStep || 1) || 1;
    const page = list.pageParam ? (Number(params[list.pageParam]) || 1) : Math.floor(off / size) + 1;
    referer = tmplGroup(String(list.referer).split('{from}').join(String(off)).split('{offset}').join(String(off)).split('{page}').join(String(page)), group);
  }
  if (referer) init.referrer = referer; // same-origin referer set from the tab; DNR is the fallback
  const res = await withReferer(url, referer, () => NET(url, init));
  // On failure, include which header NAMES we sent (never values) — so a diagnostic report shows whether
  // e.g. `authorization` reached the request, without the contributor needing DevTools.
  if (!res.ok) throw new Error('list ' + res.status + ' — ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160) + ' [sent: ' + (res.sentHeaders || Object.keys(init.headers || {})).join(',') + ']');
  // Server-rendered list (no JSON API): parse the items out of the page HTML.
  if (html) return { __items: extractListItems(await res.text(), list) };
  return await res.json();
}

// Extract list items from a server-rendered page: embedded JSON at `itemsPath`, else the rows of the
// (largest) HTML table — each row → an object keyed by column header, plus `href` of its link(s).
export function extractListItems(html, list) {
  if (list.rows) return parseHtmlItems(html || '', list.rows); // repeated-block extraction (AEM/WiZink)
  if (list.itemsPath) {
    for (const obj of embeddedObjects(html || '')) {
      const arr = get(obj, list.itemsPath);
      if (Array.isArray(arr)) return arr;
    }
  }
  return parseHtmlRows(html || '');
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Extract records from repeated HTML blocks that aren't a clean table/JSON — e.g. WiZink's AEM movements.
// cfg = { row: 'movement-item', fields: { date:{sel:'movement-date'}, total:{sel:'movement-amount'},
//   concept:{tag:'h4'}, category:{attr:'data-category'}, id:{re:'movItem_(\\d+)'} } }. A row spans from one
// `row` class marker to the next; a field is the first element carrying a class (sel) / a tag / an attribute / a regex group.
export function parseHtmlItems(html, cfg) {
  if (!cfg) return [];
  // Collapse whitespace so patterns are robust to the huge \r\n+indent runs in server-rendered (AEM)
  // markup — otherwise a bounded gap in an `each` regex (link → label) never reaches its target.
  html = String(html || '').replace(/\s+/g, ' ');
  // Sectioned items: split by a section marker (e.g. each shipment header), read section-level fields from
  // the section, and merge them into every item found within it (item fields win on conflict). Lets each
  // item inherit a property of its container — e.g. an order's items each carry their shipment's return
  // status, whether the shipment holds one item or many (1:N). Item fields still win on any key clash.
  if (cfg.section) {
    const secRe = new RegExp(cfg.section.each, 'g');
    const idx = []; let sm; while ((sm = secRe.exec(html))) idx.push(sm.index);
    const inner = { ...cfg, section: undefined };
    if (!idx.length) return parseHtmlItems(html, inner); // no sections found → flat
    if (idx[0] > 0) idx.unshift(0); // capture any items before the first section marker
    idx.push(html.length);
    const out = [];
    for (let i = 0; i < idx.length - 1; i++) {
      const sec = html.slice(idx[i], idx[i + 1]);
      const sf = {}; for (const k of Object.keys(cfg.section.fields || {})) sf[k] = extractField(sec, cfg.section.fields[k]);
      for (const it of parseHtmlItems(sec, inner)) out.push({ ...sf, ...it });
    }
    return out;
  }
  // `each` regex mode: each match is a row; fields map to capture groups ({group:1}) or sub-extract from m[0].
  if (cfg.each) {
    const re = new RegExp(cfg.each, 'g'), out = []; let m;
    while ((m = re.exec(html))) {
      const o = {}; for (const k of Object.keys(cfg.fields || {})) { const f = cfg.fields[k]; o[k] = f.group != null ? (m[f.group] || '') : extractField(m[0], f); }
      out.push(o);
    }
    return out;
  }
  if (!cfg.row) return [];
  const re = new RegExp('class=["\'][^"\']*\\b' + escapeRe(cfg.row) + '\\b', 'g');
  const idx = []; let m; while ((m = re.exec(html || ''))) idx.push(m.index);
  const req = cfg.require ? (Array.isArray(cfg.require) ? cfg.require : [cfg.require]) : [];
  const out = [];
  for (let i = 0; i < idx.length; i++) {
    const block = String(html).slice(idx[i], i + 1 < idx.length ? idx[i + 1] : undefined);
    const o = {}; for (const k of Object.keys(cfg.fields || {})) o[k] = extractField(block, cfg.fields[k]);
    if (req.every((k) => o[k] != null && o[k] !== '')) out.push(o); // drop header/summary rows missing required fields
  }
  return out;
}
function extractField(block, s) {
  try {
    if (s.re) { const m = block.match(new RegExp(s.re, 'i')); return m ? String(m[1] != null ? m[1] : m[0]).trim() : ''; }
    if (s.attr) { const m = block.match(new RegExp(escapeRe(s.attr) + '\\s*=\\s*["\']([^"\']*)["\']', 'i')); return m ? m[1].trim() : ''; }
    if (s.tag) { const m = block.match(new RegExp('<' + s.tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + s.tag + '>', 'i')); return m ? stripTags(m[1]) : ''; }
    if (s.sel) { const m = block.match(new RegExp('class=["\'][^"\']*\\b' + escapeRe(s.sel) + '\\b[^"\']*["\'][^>]*>([\\s\\S]*?)<', 'i')); return m ? stripTags(m[1]) : ''; }
  } catch (e) {}
  return '';
}
const unescapeHtml = (s) => String(s).replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// Bootstrap JSON embedded in a page: <script> blobs (Next/Nuxt/JSON-LD) AND React/Inertia
// `data-props`/`data-page`/`data-state` attributes (HTML-entity escaped) — hover.com uses the latter.
export function embeddedObjects(html) {
  const out = [], H = html || '';
  const push = (s) => { try { out.push(JSON.parse(String(s).trim())); } catch (e) {} };
  // ALL <script type="application/json"> blocks (Next, JSON-LD, Vike's vike_pageContext, …), not just
  // the first — so itemsPath can pick the right one when a page has several.
  for (const m of H.matchAll(/<script\b[^>]*\btype=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)) push(m[1]);
  for (const m of H.matchAll(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi)) push(m[1]);
  for (const m of H.matchAll(/window\.__(?:NUXT|INITIAL_STATE)__\s*=\s*([\s\S]*?);?\s*<\/script>/gi)) push(m[1]);
  for (const m of H.matchAll(/data-(?:props|page|state)=(['"])([\s\S]*?)\1/gi)) push(unescapeHtml(m[2]));
  return out;
}
function parseHtmlRows(html) {
  const tables = (html.match(/<table[\s\S]*?<\/table>/gi) || []).sort((a, b) => b.length - a.length);
  const tbl = tables[0];
  if (!tbl) return [];
  const trs = tbl.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  if (trs.length < 2) return [];
  const head = (trs[0].match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
  const out = [];
  for (let i = 1; i < trs.length; i++) {
    const cells = trs[i].match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
    if (!cells.length) continue;
    const o = {};
    cells.forEach((c, k) => { o[head[k] || 'col' + k] = stripTags(c); });
    const hrefs = [...trs[i].matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
    if (hrefs.length) { o.href = hrefs[0]; o.hrefs = hrefs; }
    out.push(o);
  }
  return out;
}
const itemsPathOf = (list) => (list.from === 'html' ? '__items' : list.itemsPath);
// Resolve the items array. `itemsPath` may be an ARRAY of candidate paths — some APIs return the list under
// different keys depending on the call (Openbank's first page is flat `movimientos`; a paginated/continuation
// page nests it under `methodResult.movimientos`). Try each; take the first that yields a non-empty array,
// else the first that is at least an array, else [].
function getItems(data, list) {
  // Component-keyed responses (AliExpress mtop): the items aren't an array but sibling OBJECT keys sharing a
  // prefix (data.data.pc_om_list_order_<id>). `itemsFromKeys {at, prefix, sub?}` collects each such value
  // (optionally its `sub` field) into an array, in insertion order.
  const kp = list.itemsFromKeys;
  if (kp && kp.prefix) {
    const parent = get(data, kp.at) || {};
    const out = [];
    for (const [k, v] of Object.entries(parent)) if (String(k).startsWith(kp.prefix)) out.push(kp.sub ? get(v, kp.sub) : v);
    return out.filter((x) => x != null);
  }
  const p = itemsPathOf(list);
  if (Array.isArray(p)) {
    let firstArr = null;
    for (const cand of p) { const v = get(data, cand); if (Array.isArray(v)) { if (v.length) return v; if (firstArr == null) firstArr = v; } }
    return firstArr || [];
  }
  return get(data, p) || [];
}

// Normalize a date value to ISO (YYYY-MM-DD). Handles ISO/ISO-datetime, epoch s/ms, textual months
// (English + Spanish, "October 22, 2021" / "22 de octubre de 2021"), and D/M/Y numeric — so lists
// sort correctly and records are consistent. Unparseable → returned unchanged.
const MONTHS = {};
[['january', 'jan', 'enero', 'ene'], ['february', 'feb', 'febrero'], ['march', 'mar', 'marzo'],
  ['april', 'apr', 'abril', 'abr'], ['may', 'mayo'], ['june', 'jun', 'junio'], ['july', 'jul', 'julio'],
  ['august', 'aug', 'agosto', 'ago'], ['september', 'sep', 'sept', 'septiembre', 'setiembre'],
  ['october', 'oct', 'octubre'], ['november', 'nov', 'noviembre'], ['december', 'dec', 'diciembre', 'dic'],
].forEach((names, i) => names.forEach((n) => { MONTHS[n] = i + 1; }));
const pad2 = (n) => String(n).padStart(2, '0');
export function normalizeDate(v) {
  if (v == null || v === '') return v;
  const s = String(v).trim();
  if (/^\d{4}$/.test(s)) return s; // a bare year is year-precision (e.g. Amazon's per-year list) — keep it, don't fake 01-01
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (/^\d{10,13}$/.test(s)) { const n = Number(s); const d = new Date(n < 1e12 ? n * 1000 : n); if (!isNaN(+d)) return d.toISOString().slice(0, 10); }
  const low = s.toLowerCase();
  m = low.match(/\b([a-záéíóúñ]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/); // Month DD, YYYY
  if (m && MONTHS[m[1]]) return `${m[3]}-${pad2(MONTHS[m[1]])}-${pad2(m[2])}`;
  m = low.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:de\s+)?([a-záéíóúñ]{3,})\.?,?\s+(?:de\s+)?(\d{4})\b/); // DD [de] Month[,] [de] YYYY (AliExpress "15 jun, 2025")
  if (m && MONTHS[m[2]]) return `${m[3]}-${pad2(MONTHS[m[2]])}-${pad2(m[1])}`;
  m = s.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/); // numeric D/M/Y, M/D/Y or Y/M/D
  if (m) {
    if (m[1].length === 4) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
    const a = +m[1], b = +m[2], y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    const day = a > 12 ? a : (b > 12 ? b : a), mon = a > 12 ? b : (b > 12 ? a : b); // D/M unless clearly M/D
    return `${y}-${pad2(mon)}-${pad2(day)}`;
  }
  m = low.match(/^(\d{1,2})\s+(?:de\s+)?([a-záéíóúñ]{3,})\.?$/); // DD MON (no year) — WiZink movements; infer year
  if (m && MONTHS[m[2]]) {
    const now = new Date(), mon = MONTHS[m[2]];
    let y = now.getFullYear();
    if (new Date(Date.UTC(y, mon - 1, +m[1])).getTime() - now.getTime() > 7 * 86400000) y -= 1; // future → last year
    return `${y}-${pad2(mon)}-${pad2(+m[1])}`;
  }
  const d = new Date(s); return isNaN(+d) ? s : d.toISOString().slice(0, 10);
}

// Spanish/EUR amount text → number. "21,00 €" → 21 · "1.234,56 €" → 1234.56 · "-5,00"/"5,00-" → -5.
// ISO 4217 minor-unit exponent for a currency — how many decimals it has. Default 2; the exceptions are
// the zero-decimal currencies (JPY, KRW, HUF-as-traded, …) and the three-decimal ones (BHD, KWD, …). Used
// to turn an integer minor-unit amount into a real value per the transaction's OWN currency.
const CCY_EXP0 = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const CCY_EXP3 = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
export function minorExp(ccy) {
  const c = String(ccy || '').toUpperCase();
  return CCY_EXP0.has(c) ? 0 : CCY_EXP3.has(c) ? 3 : 2;
}

export function normalizeAmount(v) {
  if (v == null || v === '' || typeof v === 'number') return v;
  let s = String(v).replace(/[\s ]|€|eur/gi, '');
  if (!s) return v;
  const neg = /^-|-$|^\(|\)$/.test(s);
  s = s.replace(/[()+\-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'); // strip thousands '.', decimal ','→'.'
  const n = parseFloat(s);
  return isNaN(n) ? v : (neg ? -n : n);
}

// Map fresh items onto the shared docs array; returns how many were newly added.
function collect(adapter, data, seen, all, group) {
  const list = adapter.api.list;
  let items = getItems(data, list);
  // Optional item filter: keep only items whose `field` value is in `values` (e.g. a list that mixes ONLINE
  // and IN_STORE orders → keep the online ones). dotted field path supported.
  if (list.keep && list.keep.field && Array.isArray(list.keep.values)) {
    const vals = new Set(list.keep.values.map(String));
    items = items.filter((p) => vals.has(String(get(p, list.keep.field))));
  }
  let added = 0;
  for (const p of items) {
    const doc = mapDoc(adapter, p, group); // carries doc.internalId (templated {group.*}, or synthesized for periods)
    const id = doc.internalId;
    if (id != null && seen.has(id)) continue;
    if (id != null) seen.add(id);
    all.push(doc); added++;
  }
  return added;
}

function mapDoc(adapter, p, group) {
  const f = adapter.fields, doc = { _raw: p };
  if (group) doc._group = group; // the parent (account) this record belongs to
  for (const k in f) doc[k] = resolveField(f[k], p, group);
  // Multi-period grouped rows (WiZink movements) carry NO per-movement id in the HTML. If the source's
  // fields.internalId didn't resolve to one, synthesize a STABLE composite from the group + period +
  // per-period index + raw date + raw amount, so re-runs dedupe (same input → same id).
  if ((doc.internalId == null || doc.internalId === '') && adapter.api && adapter.api.list && adapter.api.list.periods)
    doc.internalId = [group && (group.accountNumber != null ? group.accountNumber : group.id), p._period, p._idx, p.date, p.amount].filter((x) => x != null && x !== '').join('|');
  // Date fields → ISO (textual/locale, also epoch ms/s). `valueDate` is the bank movement's value date
  // (distinct from the booked `date`), promoted to a canonical field when a source maps it.
  for (const k of ['date', 'valueDate']) if (doc[k] != null && doc[k] !== '') doc[k] = normalizeDate(doc[k]);
  // Amount fields → Number. `balanceAfter` is the running balance a bank movement leaves behind.
  for (const k of ['total', 'amount', 'balanceAfter']) if (typeof doc[k] === 'string' && doc[k] !== '') doc[k] = normalizeAmount(doc[k]); // "21,00 €" → 21
  // Minor-unit amounts: some APIs return integer minor units. `amountScale` is a FIXED factor (e.g. 0.01);
  // `minorUnits:true` scales by the transaction's OWN currency exponent (ISO 4217) so a JPY amount (0 decimals)
  // and a EUR amount (2) both come out right. Raw values stay untouched in record.extra via keepRaw. The
  // running balance shares the movement's currency, so it scales the same way.
  const scale = adapter.minorUnits ? Math.pow(10, -minorExp(doc.currency)) : adapter.amountScale;
  if (scale) for (const k of ['total', 'amount', 'balance', 'balanceAfter']) if (typeof doc[k] === 'number') doc[k] = doc[k] * scale;
  doc.category = categorize(adapter, p);
  // A generic display label across schemas (store / issuer / counterparty / instrument / …). When none
  // resolve (e.g. a source whose list encrypts everything but the id, like Amazon), fall back to the
  // adapter's `itemLabel` template (e.g. "Pedido {internalId}") so every row is still identifiable.
  // A field may map to a nested object (e.g. an issuer/store {name,…}) — display its name, never "[object Object]".
  const nameOf = (v) => (v && typeof v === 'object') ? (v.name || v.nombre || v.descripcion || '') : (v == null ? '' : String(v));
  doc.label = nameOf(doc.storeName) || nameOf(doc.issuer) || nameOf(doc.counterparty) || nameOf(doc.instrument) || nameOf(doc.description) || nameOf(doc.party)
    || (adapter.itemLabel ? applyTmpl(adapter.itemLabel, doc, doc.internalId) : '');
  applyNormalize(doc, adapter); // declarative derivations (e.g. counterparty from description) before the record is built
  doc.record = buildRecord(doc, adapter);
  return doc;
}
function categorize(adapter, p) {
  const c = adapter.categorize;
  if (!c) return (adapter.categories && adapter.categories[0]) || 'other';
  return (c.map && c.map[get(p, c.field)]) || c.default || 'other';
}
// Date window for a POST body (as opposed to rangeParams, which puts the window in the QUERY string).
// Exposes {fromDate}=now-window and {toDate}=now as YYYY-MM-DD, driven by list.window (e.g. "5y").
function bodyDates(list) {
  if (!list || !list.window) return {};
  const now = new Date();
  const from = new Date(Date.now() - windowMs(list.window));
  return { fromDate: from.toISOString().slice(0, 10), toDate: now.toISOString().slice(0, 10) };
}
function rangeParams(list) {
  if (!list.range) return {};
  const now = new Date();
  const from = new Date(Date.now() - windowMs(list.window));
  const fmt = (dt) => (list.range.format === 'date' ? dt.toISOString().slice(0, 10) : dt.toISOString());
  const out = {};
  if (list.range.from) out[list.range.from] = fmt(from);
  if (list.range.to) out[list.range.to] = fmt(now);
  return out;
}
// Safe dotted-path getter: get(obj, 'a.b.c'); falls back to a plain key when there's no dot.
function get(obj, path) {
  if (obj == null || path == null) return undefined;
  if (path === '$' || path === '') return obj; // the response itself (e.g. a top-level array — no wrapper object)
  const s = String(path);
  if (s.indexOf('.') < 0 && s.indexOf('[') < 0) return obj[s];
  // Each segment is a plain key OR an array selector `key[field=value]` — pick the element whose `field`
  // (itself a dotted path) equals `value`. Lets a source read e.g. ING's IBAN out of a typed identifiers[]:
  //   identifiers[type=PRODUCT_NUMBER].value
  return s.split('.').reduce((o, k) => {
    if (o == null) return undefined;
    const m = k.match(/^([^[]+)\[([^=\]]+)=([^\]]*)\]$/);
    if (!m) return o[k];
    const arr = o[m[1]];
    return Array.isArray(arr) ? arr.find((e) => e != null && String(get(e, m[2])) === m[3]) : undefined;
  }, obj);
}
function windowMs(w) {
  // Accept days / months / years — e.g. "90d" (WiZink: only the last 90 days need no extra auth), "6m", "3y".
  const m = /^(\d+)\s*([dmy])$/.exec(String(w || '3y').trim());
  const n = m ? +m[1] : 3, unit = m ? m[2] : 'y';
  const days = unit === 'd' ? n : unit === 'm' ? n * 30 : n * 365;
  return days * 24 * 3600 * 1000;
}
