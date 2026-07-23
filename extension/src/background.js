// Background service worker. Stores captured session auth (never on disk) and, on the
// user's own login, runs any `mode: auto` route: list -> only NEW (per ledger) -> send to
// a SW-runnable sink (drive/http) -> mark -> notify. This is triggered by the user's own
// login, not a background job while they're away.
import { chrome } from './lib/ext.js';
import { getConfig } from './lib/config.js';
import { registerCapture } from './lib/capture.js';
import { loadAuth, hasAuth, capturePathAllowed } from './lib/authstore.js';
import { pushDiag, recordingNet, pushReqCtx, redactReqVal as rcRedactVal } from './lib/diag.js';
import { deliveredSet, markDelivered, appendLog, rememberDocMeta } from './lib/state.js';
import { listInventory, listGroups, artifactKinds, fetchArtifact, documentExt } from './runtime/inventory.js';
import { resolveSiteFetch, ensureSiteFetch, recoverSession, withBrandHost } from './lib/pagefetch.js';
import { renderPage, isChallenged, challengeUrlOf } from './lib/render.js';
import { writeToSink, readSinkRecords } from './sinks/sinks.js';
import { recordDelivered, putItems } from './lib/store.js';
import { getHandle } from './lib/fs.js';
import { nextOccurrence } from './lib/schedule.js';
import { acceptsDoc, sinkAcceptsArtifact, sinkAcceptsSource, bakeLearned, adoptDetailMeta } from './sinks/format.js';
import { outputsForSink, outputsOf, resolveOutput, storeKeyOf } from './lib/outputs.js';
import { getAdapters } from './adapters/index.js';
import { hasConsent } from './lib/consent.js';
import { badgeWorking, badgeCount, badgeError, badgeClear, setStatus } from './lib/badge.js';
import { t } from './lib/i18n.js';
import { getSubmitter } from './lib/submitter.js';
import { getMyHandoffs } from './registry/client.js';
import { validateProposal, originHost, enabledSources } from './lib/exthooks.js';
import { getGrant, grantsForOrigin, grantUsableBy, touchGrant } from './lib/grants.js';
import { migrateSinkHeaders } from './lib/sinkheaders.js';
import { runStoreMigration } from './lib/migrate.js';
import { autoDebounced, retainAutoDebounce, isLoginNavigation, needsTabEscalation, sweepSinkId, AUTO_CAPTURE_SETTLE_MS } from './lib/autosync.js';

// On startup, (re)register the in-session capture bridge for every enabled source (dynamic content
// scripts can be dropped on an extension update). Idempotent; needs the host permission already granted.
(async () => {
  try {
    const cfg = await getConfig();
    const adapters = await getAdapters();
    for (const d of (cfg.datasources || []).filter((x) => x.enabled)) { const a = adapters[d.adapter]; if (a) await registerCapture(a); }
    // One-time: re-normalize stored records to the current schema (bank balanceAfter/valueDate; Trade Republic
    // investment@2) and reset read/write sink ledgers so the next Sync re-pushes the corrected records.
    runStoreMigration(adapters).then((r) => {
      if (r && r.records) appendLog({ kind: 'migrate', ok: true, msg: `Re-normalized ${r.records} stored record(s) across ${r.changed.length} source(s); reset ${r.resets} delivery ledger(s).` });
    }).catch(() => {});
  } catch (e) {}
  // One-time: encrypt any pairing-token headers left plaintext in config by older versions.
  migrateSinkHeaders().catch(() => {});
  syncWebRequestCapture();
  syncLearnAssetCapture().catch(() => {}); // (re)arm record-mode document capture if a recording is in progress
  syncSchedules().catch(() => {}); // (re)arm the download planner's alarms; overdue ones fire the catch-up
  try { chrome.alarms.create('contrib:poll', { periodInMinutes: 20 }); } catch (e) {} // poll for team replies to the user's handoffs
  checkContribReplies(); // check once on startup so a reply that arrived while closed notifies promptly
})();
// Re-sync the webRequest capture filter + the schedule alarms when the config changes.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && (ch['habeas:config'] || ch['habeas:sources'])) syncWebRequestCapture();
  if (area === 'local' && ch['habeas:config']) syncSchedules().catch(() => {});
  if (area === 'local' && ch['habeas:learn']) syncLearnAssetCapture().catch(() => {});
});
// The download planner: chrome.alarms wakes the SW at each schedule's fire time (a browser that was closed
// fires the overdue alarm on next start → catch-up). onAlarm runs the schedule, then re-arms next / retry.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && String(alarm.name).startsWith('sched:')) onScheduleAlarm(alarm.name.slice(6)).catch(() => {});
  else if (alarm && alarm.name === 'contrib:poll') checkContribReplies();
});

// ---- auth/context capture (shared by the page hook messages AND the webRequest observer) ----------
async function saveAuth(host, path, headers) {
  const key = 'auth:' + host;
  const o = await chrome.storage.session.get(key);
  const cur = o[key] || { merged: {}, byPath: {}, ctx: {} };
  cur.merged = { ...cur.merged, ...headers };
  if (path) cur.byPath[path] = { ...(cur.byPath[path] || {}), ...headers };
  await chrome.storage.session.set({ [key]: cur });
}
async function saveContext(host, name, value) {
  const key = 'auth:' + host;
  const o = await chrome.storage.session.get(key);
  const cur = o[key] || { merged: {}, byPath: {}, ctx: {} };
  cur.ctx = { ...(cur.ctx || {}), [name]: value };
  await chrome.storage.session.set({ [key]: cur });
}

// webRequest-based capture: observe request headers (Authorization) + URLs (context values, e.g. a DNI)
// for enabled BEARER sources. Unlike the page fetch/XHR hook this is race-free (always listening in the
// background, before the SPA runs) and can't be seen by the page — needed for SPAs that fetch their
// token/ids before the injected hook is ready. Only headers/URLs are read; never response bodies/cookies.
let WR_MAP = {};
// Redacted request-context ring: the observer sees the FULL headers (Origin/Referer/Cookie the sample hook
// drops) on BOTH the SPA's own request AND our replay fetch to the same URL. We stash a REDACTED context per
// requestId here, fill the HTTP status when the response arrives, and commit it — so a report can diff a
// working request (HTTP 200) against a failing one (HTTP 401). Never keeps header values/cookies/tokens/query.
let RC_PENDING = {};
// FNV-1a 32-bit → base36: a short, NON-reversible fingerprint of a header value. Same value → same hash, so a
// working request and a failing one can be diffed value-by-value ("is our `sec-fetch-site` really identical?")
// without ever transmitting the values. Sensitive headers (cookie/authorization) are never hashed.
function rcHash(s) { let h = 0x811c9dc5 >>> 0; const str = String(s == null ? '' : s); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); }
const RC_NOHASH = new Set(['cookie', 'authorization']); // cookie = sensitive; authorization = covered by iat/exp (+ a value hash to confirm byte-identity)
function rcHostOnly(v) { try { return new URL(v).host; } catch (e) { return v ? 'set' : ''; } }
function rcHostSeg(v) { try { const u = new URL(v); let s = (u.pathname.split('/').filter(Boolean)[0] || ''); if (s.length > 16 || /\d/.test(s)) s = '…'; return u.host + (s ? '/' + s : ''); } catch (e) { return v ? 'set' : ''; } }
// Decode ONLY the timing claims (iat/exp) of a sent bearer — never the token, never identity claims. Lets the
// report show whether a WORKING request and a FAILING one carried the SAME token ISSUANCE or a different one:
// a rotated/revoked-but-unexpired token is "valid" by exp yet rejected, and two issuances have different iat.
function rcTokenTiming(authValue) {
  try {
    const m = String(authValue || '').match(/eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\./);
    if (!m) return null;
    const p = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
    const t = {};
    if (typeof p.iat === 'number') t.iat = p.iat;
    if (typeof p.exp === 'number') t.exp = p.exp;
    return (t.iat != null || t.exp != null) ? t : null;
  } catch (e) { return null; }
}
function stashReqCtx(details, adapters) {
  try {
    const ids = [...new Set((adapters || []).map((a) => a && a.id).filter(Boolean))];
    if (!ids.length) return;
    const reqH = details.requestHeaders || [];
    const u = new URL(details.url);
    const names = reqH.map((h) => h.name.toLowerCase()).filter(Boolean).sort();
    const oh = reqH.find((h) => h.name.toLowerCase() === 'origin');
    const rh = reqH.find((h) => h.name.toLowerCase() === 'referer');
    const ah = reqH.find((h) => h.name.toLowerCase() === 'authorization');
    const hh = {}; // per-header value fingerprint (non-sensitive headers only), to diff values not just names
    for (const h of reqH) { const n = h.name.toLowerCase(); if (n && !RC_NOHASH.has(n)) hh[n] = rcHash(h.value); }
    // Query params: id-redacted so the filter STRUCTURE shows (filter=all vs filter=customerId eq [id] & type eq
    // TA_INTERNAL) without leaking a private id. Enums/paging/dates stay readable; ids become [id].
    const qp = {}; let hasQ = false;
    for (const [k, v] of u.searchParams) { qp[k] = rcRedactVal(v); hasQ = true; }
    // Raw header ORDER (not the sorted `names`) — a WAF can reject on header-order fingerprint alone.
    const order = reqH.map((h) => h.name.toLowerCase()).join(',').slice(0, 400);
    const ctx = { path: rcRedactVal(u.pathname), method: details.method, origin: oh ? rcHostOnly(oh.value) : '', referer: rh ? rcHostSeg(rh.value) : '', cookie: names.includes('cookie'), names: names.join(',').slice(0, 300), hh, order, query: hasQ ? qp : null, auth: ah ? rcHash(ah.value) : null, tok: ah ? rcTokenTiming(ah.value) : null };
    const keys = Object.keys(RC_PENDING); if (keys.length > 200) delete RC_PENDING[keys[0]]; // bound the map
    RC_PENDING[details.requestId] = { ids, ctx };
  } catch (e) {}
}
function onReqCtxResponse(details) {
  const p = RC_PENDING[details.requestId]; if (!p) return;
  delete RC_PENDING[details.requestId];
  const ctx = { ...p.ctx, status: details.statusCode };
  for (const id of p.ids) pushReqCtx(id, ctx);
}
function onWebRequestHeaders(details) {
  try {
    const u = new URL(details.url);
    const adapters = WR_MAP[u.host];
    if (!adapters || !adapters.length) return;
    stashReqCtx(details, adapters); // record the redacted request context (committed with status on response)
    const reqH = details.requestHeaders || [];
    for (const a of adapters) {
      // The source can declare WHERE its token lives (auth.capturePaths / ignorePaths). The observer's URL
      // filter is already scoped to those paths, but gate here too so a shared-host sibling can't store from
      // a path outside its own capture area. Context values (below) still capture from any observed request.
      const onCapturePath = capturePathAllowed(a, u.pathname);
      // The token can live in a header OTHER than Authorization (e.g. Openbank's `openbankauthtoken`) —
      // a source declares `auth.tokenHeader`. Gate on that header + tokenMatch, then capture it and every
      // companion header the source replays (e.g. ING's x-ing-extendedsessioncontext).
      const tokenHeader = ((a.auth && a.auth.tokenHeader) || 'authorization').toLowerCase();
      const tok = reqH.find((h) => h.name.toLowerCase() === tokenHeader);
      if (onCapturePath && tok && tok.value) {
        const tm = (a.auth && a.auth.tokenMatch) || 'eyJ';
        let ok; try { ok = new RegExp(tm).test(tok.value); } catch (e) { ok = tok.value.indexOf(tm) >= 0; }
        if (ok) {
          const want = new Set(((a.auth && a.auth.replayHeaders) || [tokenHeader]).map((h) => h.toLowerCase()));
          const hdrs = { [tokenHeader]: tok.value };
          for (const h of reqH) { const ln = h.name.toLowerCase(); if (want.has(ln) && h.value) hdrs[ln] = h.value; }
          saveAuth(u.host, u.pathname, hdrs).then(() => { scheduleAutoRun(u.host); runPendingExternalCollects(u.host); });
        }
      }
      // Cookie source (no token to gate on): capture the declared non-cookie headers it needs replayed
      // alongside the session cookies (Revolut's `x-device-id`). Store like auth so headersFor replays them.
      if (onCapturePath && a.auth && a.auth.mode === 'cookie' && Array.isArray(a.auth.replayHeaders) && a.auth.replayHeaders.length) {
        const want = new Set(a.auth.replayHeaders.map((h) => h.toLowerCase()));
        const hdrs = {};
        for (const h of reqH) { const ln = h.name.toLowerCase(); if (want.has(ln) && h.value) hdrs[ln] = h.value; }
        if (Object.keys(hdrs).length) saveAuth(u.host, u.pathname, hdrs).then(() => { scheduleAutoRun(u.host); runPendingExternalCollects(u.host); });
      }
      for (const c of (a.auth && a.auth.context) || []) {
        let m; try { m = new RegExp(c.match).exec(details.url); } catch (e) { continue; }
        if (m && m[1]) saveContext(u.host, c.name, m[1]);
      }
    }
  } catch (e) {}
}
// (Re)build the capture map + register the header observer scoped to EXACTLY the paths each source captures
// its token from. Using a NARROW, per-source URL filter (host + auth.capturePaths, else the whole host) keeps
// the observer off the login flow entirely — a broad `https://*/*` observer with `extraHeaders` engaged with a
// bank's sensitive sign-in requests (Transmit Security) and broke the user's login. The observer is best-effort
// (only while the SW is alive); the in-page hook is the primary, SW-waking capture. No tab reload.
async function syncWebRequestCapture() {
  if (!(chrome.webRequest && chrome.webRequest.onSendHeaders)) return;
  const cfg = await getConfig();
  const adapters = await getAdapters();
  const map = {};
  const urlSet = new Set();
  const norm = (p) => (String(p).startsWith('/') ? String(p) : '/' + String(p));
  const add = (h, a) => {
    const host = bareHost(h); if (!host) return;
    (map[host] = map[host] || []).push(a);
    // Scope observed URLs to the source's declared capture paths (auth.capturePaths); no list → the whole host.
    const paths = (a.auth && Array.isArray(a.auth.capturePaths) && a.auth.capturePaths.length) ? a.auth.capturePaths.map(norm) : ['/'];
    for (const p of paths) urlSet.add(`*://${host}${p}*`);
  };
  for (const d of (cfg.datasources || []).filter((x) => x.enabled)) {
    const a = adapters[d.adapter];
    // Bearer sources capture their token; cookie sources normally carry the session in cookies alone — BUT a
    // cookie source can still need a non-cookie header replayed (Revolut's `x-device-id`) or a rotating bearer
    // observed (FECI's authorization). Capture when it declares replayHeaders or a context to grab, else skip.
    const bearer = a && a.auth && a.auth.mode === 'bearer';
    const grabsHeaders = a && a.auth && ((Array.isArray(a.auth.replayHeaders) && a.auth.replayHeaders.length) || (Array.isArray(a.auth.context) && a.auth.context.length));
    if (!a || !(bearer || grabsHeaders)) continue;
    if (a.api && a.api.host) add(a.api.host, a);
    for (const ch of a.crossDomainHosts || []) add(ch, a);
    for (const m of a.match || []) add(m, a);
  }
  WR_MAP = map;
  try { chrome.webRequest.onSendHeaders.removeListener(onWebRequestHeaders); } catch (e) {}
  try { chrome.webRequest.onHeadersReceived.removeListener(onReqCtxResponse); } catch (e) {}
  const urls = [...urlSet];
  if (!urls.length) return;
  try { chrome.webRequest.onSendHeaders.addListener(onWebRequestHeaders, { urls }, ['requestHeaders', 'extraHeaders']); }
  catch (e) { try { chrome.webRequest.onSendHeaders.addListener(onWebRequestHeaders, { urls }, ['requestHeaders']); } catch (e2) {} }
  // Pair the response status back to each stashed request context (see RC_PENDING / stashReqCtx).
  try { chrome.webRequest.onHeadersReceived.addListener(onReqCtxResponse, { urls }); } catch (e) {}
}

// ---- record-mode document capture --------------------------------------------------------------------
// The page fetch/XHR hook only sees XHR/fetch requests; a PDF/Excel opened by a link, a navigation, or a
// browser download is invisible to it (that's why a recorded session can show 0 documents). During LEARN
// mode we ALSO watch RESPONSES (webRequest) on the recorded domain and record any document-like one
// (content-type pdf/octet-stream/spreadsheet, or a Content-Disposition attachment, or a .pdf URL) into the
// same `assets:<domain>` buffer the author reads. Learn-mode only; only the URL/method are stored.
let LEARN_ASSET = null; // { domain } while recording, else null
function isDocResponse(details) {
  const h = details.responseHeaders || [];
  const g = (n) => { const x = h.find((e) => e.name.toLowerCase() === n); return x ? String(x.value || '') : ''; };
  const ct = g('content-type').toLowerCase(), cd = g('content-disposition').toLowerCase();
  return /application\/pdf|application\/octet-stream|application\/vnd\.|spreadsheet|ms-?excel|\bcsv\b/.test(ct) || /attachment/.test(cd) || /\.(pdf|xlsx?|csv)(\?|$)/i.test(details.url);
}
function onLearnHeaders(details) {
  try {
    if (!LEARN_ASSET || !isDocResponse(details)) return;
    const key = 'assets:' + LEARN_ASSET.domain;
    chrome.storage.session.get(key).then((o) => {
      const arr = (o[key] || []).filter((x) => x.url !== details.url);
      arr.unshift({ url: details.url, method: details.method, status: details.statusCode, via: 'webRequest' });
      chrome.storage.session.set({ [key]: arr.slice(0, 60) });
    });
  } catch (e) {}
}
async function syncLearnAssetCapture() {
  if (!(chrome.webRequest && chrome.webRequest.onHeadersReceived)) return;
  const o = await chrome.storage.local.get('habeas:learn');
  const l = o['habeas:learn'];
  try { chrome.webRequest.onHeadersReceived.removeListener(onLearnHeaders); } catch (e) {}
  if (l && l.active && l.domain) {
    LEARN_ASSET = { domain: l.domain };
    const urls = [`*://*.${l.domain}/*`, `*://${l.domain}/*`];
    try { chrome.webRequest.onHeadersReceived.addListener(onLearnHeaders, { urls }, ['responseHeaders']); } catch (e) {}
  } else { LEARN_ASSET = null; }
}

// Auto-sync trigger for cookie sources (and any source): when the user lands on the source's own
// site (tab finished loading in their session), try the auto routes. `tab.url` is only visible for
// hosts we have permission for — i.e. exactly the enabled/consented sources. Debounced in runAutoRoutes.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' || !tab || !tab.url || !/^https:\/\//.test(tab.url)) return;
  let host; try { host = new URL(tab.url).host; } catch (e) { return; }
  maybeAutoRunForSite(host, tabId, tab.url).catch(() => {});
});

const SAMPLE_CAP = 120; // room for a thorough multi-account session (analytics beacons are filtered at the hook, so this holds real API calls + documents)
const WS_FRAME_CAP = 200; // WebSocket/SSE frames (own buffer) — enough for the handshake + a data sample

// A single in-flight INTERACTIVE background op (Save / Send / Re-download). A `habeas:stop` aborts it; the op's
// loops poll the signal. (Sync-all has its own sweepController.)
let __opAbort = null;
// Keep the MV3 service worker alive during a long op: a periodic extension-API call resets its idle timer so it
// isn't recycled mid-operation (which would close the message channel before the caller gets a response). A
// safety timeout stops the heartbeat if an op ends without calling stopOp (there's no explicit "op done" event).
let __ka = null, __kaStop = null;
function keepAlive() {
  if (!__ka) __ka = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) {} }, 20000);
  if (__kaStop) clearTimeout(__kaStop);
  __kaStop = setTimeout(stopKeepAlive, 6 * 60 * 1000);
}
function stopKeepAlive() { if (__ka) { clearInterval(__ka); __ka = null; } if (__kaStop) { clearTimeout(__kaStop); __kaStop = null; } }
function startOp() { try { if (__opAbort) __opAbort.abort(); } catch (e) {} __opAbort = new AbortController(); keepAlive(); return __opAbort.signal; }
function stopOp() { try { if (__opAbort) __opAbort.abort(); } catch (e) {} stopKeepAlive(); }
// Live per-document progress → the Archive updates each card AS it downloads (real date/amount, then "saved"),
// not only at the end. docs: [{ internalId, stream, record?, delivered? }].
let __progSeq = 0;
function emitProgress(dsId, docs) { try { chrome.storage.local.set({ 'habeas:doc-progress': { ds: dsId, seq: ++__progSeq, docs } }); } catch (e) {} }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'habeas:ext') {
    // A third-party site (via the extbridge content script). The origin is taken from the SENDER,
    // never from the message body — the page cannot forge it.
    handleExt(msg.api, msg.payload || {}, senderOrigin(sender)).then(sendResponse, (e) => sendResponse({ ok: false, status: 'error', error: (e && e.message) || String(e) }));
    return true; // async response
  }
  if (msg.type === 'habeas:sync-all') { // user-initiated sweep of every auto route (from the popup)
    sweepAllSources().then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true; // async response
  }
  if (msg.type === 'habeas:sync-stop') { stopSweep(); sendResponse({ ok: true }); return; } // stop a running sweep
  if (msg.type === 'habeas:stop') { stopOp(); stopSweep(); sendResponse({ ok: true }); return; } // stop any in-progress interactive op
  if (msg.type === 'habeas:deliver' && msg.datasource && msg.sink) { // on-demand "save this source to this destination" (from the Archive)
    (async () => {
      const cfg = await getConfig();
      const adapters = await getAdapters();
      const ds = (cfg.datasources || []).find((d) => d.id === msg.datasource);
      const adapter = ds && adapters[ds.adapter];
      const sink = (cfg.sinks || []).find((k) => k.id === msg.sink);
      if (!ds || !adapter || !sink) return { ok: false, error: 'unknown route' };
      // Reuse the full, tested pipeline: list → filter to NEW (undelivered) → fetch → write → mark ledger + store.
      // Returns { status:'nosession' } cleanly when there's no live session (the Archive surfaces that honestly).
      // msg.force → "Re-download from site": deliver ALL listed docs, not just undelivered (re-fetches them).
      const r = await runRoute(ds, adapter, sink, { kind: 'manual', interactive: true, force: !!msg.force, signal: startOp() });
      return { ok: true, ...r };
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true; // async response
  }
  if (msg.type === 'habeas:reconcile' && msg.datasource) { // recover real dates into the store from delivered manifests
    (async () => {
      const cfg = await getConfig();
      const adapters = await getAdapters();
      const ds = (cfg.datasources || []).find((d) => d.id === msg.datasource);
      const adapter = ds && adapters[ds.adapter];
      if (!ds || !adapter) return { ok: false, error: 'unknown source' };
      keepAlive();
      try { return { ok: true, upgraded: await reconcileFromDelivered(ds, adapter) }; }
      finally { stopKeepAlive(); }
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true; // async response
  }
  if (msg.type === 'habeas:send' && msg.datasource && msg.sink && Array.isArray(msg.docs)) { // deliver HAND-PICKED docs (records passed from the Archive) to a destination
    (async () => {
      const cfg = await getConfig();
      const adapters = await getAdapters();
      const ds = (cfg.datasources || []).find((d) => d.id === msg.datasource);
      const adapter = ds && adapters[ds.adapter];
      const sink = (cfg.sinks || []).find((k) => k.id === msg.sink);
      if (!ds || !adapter || !sink) return { ok: false, error: 'unknown route' };
      const r = await sendStoredDocs(ds, adapter, sink, msg.docs, { force: !!msg.force, signal: startOp() });
      return { ok: true, ...r };
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true; // async response
  }
  if (msg.type === 'habeas:sched-run' && msg.id) { onScheduleAlarm(msg.id).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) })); return true; } // run a schedule now
  if (msg.type === 'habeas:auth' && msg.host) {
    // The in-page hook captures from ANY fetch/XHR (no URL filter), so honor the source's declared capture
    // paths here: don't store a token seen on a path the source excludes (its login flow / anonymous calls).
    const ads = WR_MAP[msg.host] || [];
    const allowed = !ads.length || ads.some((a) => capturePathAllowed(a, msg.path));
    if (allowed) saveAuth(msg.host, msg.path, msg.headers).then(() => { scheduleAutoRun(msg.host); runPendingExternalCollects(msg.host); });
  } else if (msg.type === 'habeas:context' && msg.host && msg.name) {
    // A captured CONTEXT value (e.g. a DNI seen in a request URL), stored alongside auth in
    // storage.session (never on disk) and later templated as {ctx.<name>} by the runtime.
    saveContext(msg.host, msg.name, msg.value);
  } else if (msg.type === 'habeas:sample' && msg.domain && msg.sample && msg.sample.kind === 'ws') {
    // Record-mode: WebSocket/SSE frames go in their OWN buffer — they share one wss:// URL (so the
    // by-url dedupe would keep only the last frame) and shouldn't crowd the HTTP sample cap. Dedupe
    // exact-duplicate frames (url+event+frame); keep a generous cap so the protocol + data are visible.
    const key = 'wsframes:' + msg.domain;
    chrome.storage.session.get(key).then((o) => {
      const s = msg.sample;
      const arr = (o[key] || []).filter((x) => !(x.url === s.url && x.event === s.event && x.frame === s.frame));
      arr.push(s); // chronological — the subscription/handshake order matters for authoring
      chrome.storage.session.set({ [key]: arr.slice(-WS_FRAME_CAP) });
    });
  } else if (msg.type === 'habeas:sample' && msg.domain && msg.sample) {
    // Record-mode: keep a rolling, de-duplicated (by path) buffer of observed responses.
    const key = 'samples:' + msg.domain;
    chrome.storage.session.get(key).then((o) => {
      const arr = (o[key] || []).filter((x) => x.url !== msg.sample.url);
      arr.unshift(msg.sample);
      chrome.storage.session.set({ [key]: arr.slice(0, SAMPLE_CAP) });
    });
  } else if (msg.type === 'habeas:asset' && msg.domain && msg.asset) {
    // Record-mode: remember document (PDF) request URLs so we can infer the PDF path.
    const key = 'assets:' + msg.domain;
    chrome.storage.session.get(key).then((o) => {
      const arr = (o[key] || []).filter((x) => x.url !== msg.asset.url);
      arr.unshift(msg.asset);
      chrome.storage.session.set({ [key]: arr.slice(0, SAMPLE_CAP) });
    });
  } else if (msg.type === 'habeas:dom' && msg.domain && msg.text) {
    // Record-mode: rendered page text, to tell public (visible) ids from internal ones.
    const key = 'dom:' + msg.domain;
    chrome.storage.session.get(key).then((o) => {
      const arr = (o[key] || []).filter((x) => x.url !== msg.url);
      arr.unshift({ url: msg.url, text: msg.text });
      chrome.storage.session.set({ [key]: arr.slice(0, 12) });
    });
  } else if (msg.type === 'habeas:seen' && msg.domain) {
    // Record-mode diagnostic: count requests observed per host (did the recorder run at all?).
    const key = 'seen:' + msg.domain;
    chrome.storage.session.get(key).then((o) => {
      const seen = o[key] || { total: 0, hosts: {} };
      seen.total++;
      if (msg.host) seen.hosts[msg.host] = (seen.hosts[msg.host] || 0) + 1;
      chrome.storage.session.set({ [key]: seen });
    });
  } else if (msg.type === 'habeas:storage' && msg.domain) {
    // Record-mode: keep the LATEST client-storage snapshot (local + session). SPAs stash session/entity
    // ids here that never hit the network; a redacted, correlated copy in the handoff traces them.
    chrome.storage.session.set({ ['storage:' + msg.domain]: { local: msg.local || {}, session: msg.session || {} } });
  }
});

const running = new Set();

async function runAutoRoutes(matches, tabId, triggerUrl) {
  const cfg = await getConfig();
  if (!(cfg.routes || []).some((r) => r.mode === 'auto')) return;
  const adapters = await getAdapters();
  let challenge = null; // lazily checked once, only when we're actually about to run
  for (const route of (cfg.routes || []).filter((r) => r.mode === 'auto')) {
    if (running.has(route.id)) continue;
    const ds = cfg.datasources.find((d) => d.id === route.datasource && d.enabled);
    const adapter = ds && adapters[ds.adapter];
    if (!adapter || !matches(adapter)) continue;
    // The navigation that triggered us is the source's own login page → the user isn't authenticated yet.
    // Skip (a session-gated prelude would 400) and wait for the post-login navigation to fire us again.
    if (triggerUrl && isLoginNavigation(adapter, triggerUrl)) continue;
    if (!(await hasConsent(adapter))) continue; // community/cross-domain source not yet consented
    // For a source with an observable bearer, require that the token has actually been captured before
    // running: the bearer only exists after login, so this is the robust "the user is logged in" signal —
    // it keeps auto-run (from EITHER trigger) from firing mid-login and disturbing a fragile bank session,
    // even when the source declares no loginUrl for the page-based guard above.
    if (hasObservableBearer(adapter) && !(await hasAuth(adapter))) continue;
    const sink = cfg.sinks.find((s) => s.id === route.sink);
    if (!sink || sink.type === 'download' || sink.type === 'local-folder') continue; // need a page
    const dk = 'autoLast:' + route.id;
    const o = await chrome.storage.session.get(dk);
    if (autoDebounced(o[dk], Date.now())) continue;
    // Don't run on a Cloudflare/anti-bot interstitial — the real session isn't available yet. When the
    // challenge passes, the page reloads → onUpdated fires again → this runs on the real site.
    if (tabId != null) { if (challenge === null) challenge = await isChallenged(tabId); if (challenge) return; }
    running.add(route.id);
    await chrome.storage.session.set({ [dk]: Date.now() });
    // Release the debounce on a transient/auth failure (e.g. the run fired on the login page before the
    // session was ready → csrf 400) so the user's real login re-triggers a retry at once; only a
    // completed run holds the 10-min window. Keeps a first, premature failure from muting the source.
    runRoute(ds, adapter, sink)
      .then((res) => (retainAutoDebounce(res && res.status) ? null : chrome.storage.session.remove(dk)))
      .catch(() => chrome.storage.session.remove(dk))
      .finally(() => running.delete(route.id));
  }
}
// Trigger B: the user navigated to the source's site — works for cookie sources too (no JWT to capture).
const maybeAutoRunForSite = (host, tabId, url) => runAutoRoutes((a) => siteMatches(a, host), tabId, url);

// Trigger A: captured auth (a bearer source's JWT was seen). Capture-triggered auto-run, SETTLE-DELAYED. A freshly loaded dashboard fires a burst of authenticated
// requests (each a capture); rather than launch on the first one, wait AUTO_CAPTURE_SETTLE_MS after the
// LAST capture for that host, then run once. The capture itself only happens after login is complete (the
// bearer doesn't exist before the SPA's first authenticated call), so this never fires mid-login; the delay
// also lets the session fully settle. We fire on the source's own tab so runAutoRoutes' login-page guard
// applies. If the service worker is torn down before the timer fires, no run happens (fail-safe — the next
// capture reschedules) and nothing interferes with the user's session.
const autoRunTimers = new Map();
function scheduleAutoRun(host) {
  const prev = autoRunTimers.get(host); if (prev) clearTimeout(prev);
  autoRunTimers.set(host, setTimeout(async () => {
    autoRunTimers.delete(host);
    let tab = null;
    try { const ts = await chrome.tabs.query({ url: `*://${host}/*` }); tab = ts.find((x) => x.active) || ts[0] || null; } catch (e) {}
    runAutoRoutes((a) => hostOf(a) === host, tab && tab.id, tab && tab.url);
  }, AUTO_CAPTURE_SETTLE_MS));
}
// A source whose auth carries an OBSERVABLE bearer (a `bearer` source, or a cookie source that also replays
// an `authorization` header — FECI's rotating API token) is only truly logged in once that bearer has been
// captured: the token does not exist until AFTER login. Gating auto-run on a captured token (below) makes
// "never run during login" robust regardless of what triggered the run, even for a source with no declared
// loginUrl. Pure-cookie sources (session in cookies alone, no bearer to observe) are not gated here.
function hasObservableBearer(adapter) {
  const au = adapter && adapter.auth; if (!au) return false;
  if (au.mode === 'bearer') return true;
  return au.mode === 'cookie' && Array.isArray(au.replayHeaders)
    && au.replayHeaders.some((h) => String(h).toLowerCase() === ((au.tokenHeader || 'authorization').toLowerCase()));
}

// User-initiated "Sync all now": sweep EVERY configured auto route sequentially, extracting new docs.
// Each source is tried UNATTENDED first (no tab opened — an existing tab if any, else a direct fetch);
// only on a session/anti-bot failure do we open its tab and retry in-session (which succeeds when the
// session is still valid, and lets the user log in when it isn't). Bypasses the per-route debounce (this
// is an explicit request) and emits one summary notification instead of one per source.
let sweeping = false;
let sweepController = null; // AbortController for the running sweep (so the popup can stop it)
function stopSweep() { if (sweepController) { try { sweepController.abort(); } catch (e) {} } }
async function sweepAllSources() {
  if (sweeping) return { status: 'busy' };
  sweeping = true;
  sweepController = new AbortController();
  const signal = sweepController.signal;
  try {
    const cfg = await getConfig();
    const adapters = await getAdapters();
    // Every ENABLED source (not only ones with an auto route). Each resolves a destination: auto-route sink
    // → the source's remembered favorite → the global default sink. Sources with no SW-runnable destination
    // are reported (noSink), not silently skipped.
    const autoBy = {}; (cfg.routes || []).filter((r) => r.mode === 'auto').forEach((r) => { autoBy[r.datasource] = r.sink; });
    const favs = (await chrome.storage.local.get('habeas:favsink'))['habeas:favsink'] || {};
    const def = (await chrome.storage.local.get('habeas:defaultsink'))['habeas:defaultsink'] || '';
    const swRunnable = (s) => !!s && s.type !== 'download' && s.type !== 'local-folder';
    await badgeWorking();
    let sources = 0, totalNew = 0, needLogin = 0, errors = 0, noSink = 0;
    for (const ds of (cfg.datasources || []).filter((d) => d.enabled)) {
      if (signal.aborted) break; // stopped by the user
      const adapter = adapters[ds.adapter];
      if (!adapter || !(await hasConsent(adapter))) continue;
      const sink = cfg.sinks.find((s) => s.id === sweepSinkId(ds.id, autoBy, favs, def));
      if (!swRunnable(sink)) { noSink++; continue; }
      sources++;
      setStatus(t('status_listing', [adapter.name || ds.adapter]));
      await appendLog({ kind: 'sweep', datasource: ds.id, status: 'listing' }); // incremental: "syncing X…" in the log
      let res = await runRoute(ds, adapter, sink, { kind: 'sweep', signal }); // 1) unattended
      if (signal.aborted) break; // don't open login tabs / escalate after a stop
      if (res.status === 'nosession') {
        // No captured session → open/navigate the login page (foregrounded) so the user CAN authenticate.
        // A bearer source's session only exists after login, so there's nothing to retry in-place now —
        // the user logs in and re-runs (or auto-sync resumes on capture for a source with an auto route).
        try { await recoverSession(adapter); } catch (e) {}
      } else if (needsTabEscalation(res)) {
        // Session may be live but there's no tab (anti-bot/CSRF) → open the site tab and retry in-session.
        const net = await ensureSiteFetch(adapter, { open: true }).catch(() => null);
        if (net) res = await runRoute(ds, adapter, sink, { kind: 'sweep', net, interactive: true });
      }
      if (res.status === 'done') totalNew += res.new || 0;
      else if (res.status === 'nosession' || res.status === 'challenged') needLogin++;
      else if (res.status === 'error') errors++;
    }
    const stopped = signal.aborted;
    await appendLog({ kind: 'sweep', status: stopped ? 'stopped' : 'ok', sources, new: totalNew, needLogin, errors, noSink });
    if (!stopped) notify(t('notify_sweep', [String(totalNew), String(sources)]));
    if (totalNew) await badgeCount(totalNew); else await badgeClear();
    return { status: stopped ? 'stopped' : 'done', sources, new: totalNew, needLogin, errors, noSink };
  } finally { sweeping = false; sweepController = null; }
}

const hostOf = (adapter) => adapter.api.host.replace(/^https?:\/\//, '');
const bareHost = (m) => String(m).replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '').replace(/^\*\./, '');
function siteMatches(adapter, host) {
  if (!host) return false;
  const dom = adapter.domain;
  if (dom && (host === dom || host.endsWith('.' + dom))) return true;
  for (const m of adapter.match || []) { const h = bareHost(m); if (h && (host === h || host.endsWith('.' + h))) return true; }
  return hostOf(adapter) === host;
}

// Whole store → each endpoint resolves its own auth (mixed cookie+bearer), merged across sibling hosts
// sharing the source's registrable domain. Cookie sources proceed with an empty store (cookies carry it).
const authFor = (adapter) => loadAuth(adapter);

// Ensure the STORE record carries the real date/amount, not the list-time placeholder. Amazon &c. expose only a
// YEAR in the listing; the true date lives in the per-document JSON detail. adoptDetailMeta pulls it from the
// fetched artifacts — but those are gated by what the SINK accepts (a format filter), so a PDF-only sink never
// fetches the detail and the record stays year-only → the shard store buckets it as _undated. The date is store
// metadata, independent of delivery: if it's still not a full date and the source HAS a detail, fetch it once
// just for adoption (no extra fetch when the detail was already delivered, or the date is already complete).
async function adoptRealDate(adapter, sid, auth, d, arts, net) {
  await adoptDetailMeta(d, arts);
  const detail = adapter.api && adapter.api.detail;
  const full = /^\d{4}-\d{2}-\d{2}/.test((d.record && d.record.date) || d.date || '');
  if (!full && detail && !detail.as && !arts.some((a) => a && a.ext === 'json')) {
    try { await adoptDetailMeta(d, [await fetchArtifact(resolveOutput(adapter, sid), auth, d, net, renderPage, 'data')]); }
    catch (e) { /* detail unavailable (retention/error) → keep the list date */ }
  }
}

// A delivered manifest record carries REAL data the list-time store stub lacked — not just the precise date, but
// the amount, return status, payment, line items… A record is worth recovering if it holds ANY of that richer
// content (a full date, a numeric amount, or a detail-only field), i.e. it isn't a bare year-only listing stub.
function isRichRecord(r) {
  if (!r || r.internalId == null) return false;
  return /^\d{4}-\d{2}-\d{2}/.test(String(r.date || ''))
    || typeof r.total === 'number' || typeof r.amount === 'number'
    || !!(r.returnStatus || r.refundTotal != null || r.paymentMethod || r.number)
    || !!(r.extra && Object.keys(r.extra).length) || (Array.isArray(r.items) && r.items.length > 0);
}

// Recover REAL record data into the canonical store from what was already delivered, WITHOUT re-fetching from the
// source. The store record can be a coarse stub (Amazon's list gives only a year + no amount; a past download
// determined the real date/amount/details but wrote them only to the delivered files + the sink's per-source
// manifest, not back to the store). This reads that manifest and write-throughs the richer records (whole record:
// date, amount, everything); the store's shard layer then MOVES each doc to its month shard. Returns how many
// were upgraded. Best-effort per (output × readable sink); the first sink holding the manifest wins.
async function reconcileFromDelivered(ds, adapter) {
  const cfg = await getConfig();
  const readable = (cfg.sinks || []).filter((s) => ['dropbox', 'webdav', 's3', 'local-folder', 'drive'].includes(s.type));
  const name = adapter.name || ds.adapter;
  let upgraded = 0;
  for (const o of outputsOf(adapter)) {
    const sk = storeKeyOf(adapter.id, o.stream);
    const service = adapter.service || ds.adapter;
    const stream = o.stream;
    for (const sink of readable) {
      const label = sink.name || sink.id || sink.type;
      setStatus(t('reconcile_reading', [label])); // step 1: fetch the delivered manifest
      let recs = [];
      try {
        const dirHandle = sink.type === 'local-folder' ? await getHandle('dir:' + sink.id).catch(() => null) : undefined;
        recs = await readSinkRecords(sink, { service, source: sk, dirHandle });
      } catch (e) { continue; }
      const better = (recs || []).filter(isRichRecord);
      if (!better.length) { setStatus(t('reconcile_reading_none', [label])); continue; }
      // step 2: write-through in chunks so the status counter advances and the open Archive patches cards live.
      const CHUNK = 40;
      for (let i = 0; i < better.length; i += CHUNK) {
        const batch = better.slice(i, i + CHUNK);
        await putItems(sk, batch.map((r) => ({ internalId: r.internalId, record: r })), { source: adapter.id, srcVersion: adapter.version });
        upgraded += batch.length;
        setStatus(t('reconcile_saving', [String(Math.min(i + CHUNK, better.length)), String(better.length), name]));
        emitProgress(ds.id, batch.map((r) => ({ internalId: r.internalId, stream, record: r }))); // live: cards show the recovered date/amount
      }
      break; // this output's manifest was found on one sink → no need to try the others
    }
  }
  return upgraded;
}

// Deliver a SPECIFIC set of already-stored documents (hand-picked in the Archive) to a sink. Unlike runRoute
// (which LISTS new docs), this works straight from the canonical store — the user chose exact items to push
// somewhere. The normalized record always delivers (manifest); a per-item file is re-fetched when the source can
// still produce it and there's a live session (best-effort — old items whose PDF template needs list-only fields
// just deliver record-only, same contract as the popup's store-loaded send).
async function sendStoredDocs(ds, adapter, sink, picked, opts = {}) {
  const name = adapter.name || ds.adapter;
  const found = (picked || []).length;
  if (!found) return { status: 'done', sent: 0, found: 0, accepted: 0 };
  await badgeWorking();
  setStatus(t('status_fetching', [String(found), name]));
  try {
    const auth = await authFor(adapter);
    // Open the site tab only if the outputs can produce FILES (a per-item PDF/Excel needs the page-context
    // fetch); a records-only send never fetches. opts.force ("Re-download from site") always opens it.
    const wantsDocs = opts.force || outputsOf(adapter).some((o) => artifactKinds(resolveOutput(adapter, o.id)).length);
    const net = auth ? await ensureSiteFetch(adapter, { open: wantsDocs }).catch(() => null) : null; // null → records-only delivery still works
    adapter = withBrandHost(adapter, net); // brand (multi-TLD) source → api.host = the domain the user's tab is on
    // The RECORDS were passed in from the Archive page (which already read the store) → no store re-read here,
    // so a Dropbox/folder-backed archive that the service worker can't list still works. Group by stream.
    const byStream = new Map();
    for (const dd of picked) { const s = (dd && dd.stream) || ''; (byStream.get(s) || byStream.set(s, []).get(s)).push(dd); }
    let sent = 0, accepted = 0;
    for (const [sid, list] of byStream) {
      if (opts.signal && opts.signal.aborted) break; // Stop pressed
      const eff = resolveOutput(adapter, sid); const sk = storeKeyOf(adapter.id, sid);
      const docs = list.filter((dd) => dd && dd.internalId != null).map((dd) => {
        const rec = dd.record || {};
        // category MUST be on the doc top-level: acceptsDoc(sink, doc) reads doc.category. Fall back to the source's default.
        const category = rec.category != null ? rec.category : ((adapter.categorize && adapter.categorize.default) || (adapter.categories && adapter.categories[0]));
        return { internalId: dd.internalId, record: rec, date: rec.date, total: rec.total ?? rec.amount, currency: rec.currency, category, type: rec.type, group: rec.group || '', _stream: sid, _storeKey: sk, _fromStore: true };
      });
      const eligible = docs.filter((d) => acceptsDoc(sink, d))
        .sort((a, b) => ((a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0));
      accepted += eligible.length;
      if (!eligible.length) continue;
      const fmts = outputsOf(adapter).filter((o) => o.stream === sid).map((o) => o.format); // all this stream's formats
      const files = new Map();
      let n = 0, pending = [];
      // Checkpoint every CHUNK docs (see runRoute): a long re-download persists incrementally so an
      // interruption loses at most one chunk, not the whole batch. The `download` (ZIP) sink → one final flush.
      const CHUNK = sink.type === 'download' ? Infinity : 25;
      const flushChunk = async () => {
        if (!pending.length) return;
        const batch = pending; pending = [];
        setStatus(t('status_sending', [String(batch.length), sink.id]));
        await writeToSink(sink, batch, files, { service: adapter.service || ds.adapter, source: sk, ext: documentExt(eff) || 'pdf', interactive: true });
        await markDelivered(ds.id, sink.id, batch.map((d) => d.internalId));
        for (const d of batch) d.record = bakeLearned(d);
        emitProgress(ds.id, batch.map((d) => ({ internalId: d.internalId, stream: sid, record: d.record, delivered: sink.id }))); // live: flip cards to "saved"
        try { await recordDelivered(sk, batch, { source: adapter.id, schema: eff.schema, srcVersion: adapter.version }); } catch (e) { /* store best-effort */ }
        try { await rememberDocMeta(adapter.id, batch.map((d) => ({ internalId: d.internalId, date: /^\d{4}-\d{2}-\d{2}/.test(d.date || '') ? d.date : undefined, total: typeof d.total === 'number' ? d.total : undefined }))); } catch (e) {}
        for (const d of batch) files.delete(d.internalId); // bound memory
        sent += batch.length;
      };
      if (net) for (const d of eligible) {
        if (opts.signal && opts.signal.aborted) break; // Stop pressed — stop before the next doc (flushed chunks are safe)
        const arts = [];
        for (const fmt of (fmts.length ? fmts : [''])) {
          const oeff = resolveOutput(adapter, sid + (fmt ? '/' + fmt : ''));
          const kinds = artifactKinds(oeff).filter((k) => sinkAcceptsArtifact(sink, k));
          const avail = artifactKinds(oeff, d); // per-doc: skip a document kind this item lacks
          for (const k of kinds) {
            if (!avail.some((a) => a.kind === k.kind)) continue;
            const rc = recordingNet(net);
            try { arts.push(await fetchArtifact(oeff, auth, d, rc.net, renderPage, k.kind)); }
            catch (e) { const msg = (e && e.message) || String(e); if (!/no document for this (item|source)|no PDF for this source/i.test(msg)) pushDiag(adapter.id, { phase: 'document', output: sid, item: d.date || d.internalId, message: msg, method: rc.ref.last && rc.ref.last.method, url: rc.ref.last && rc.ref.last.url, status: rc.ref.last && rc.ref.last.status }); }
          }
        }
        await adoptRealDate(adapter, sid, auth, d, arts, net); // real date/amount from the JSON detail (fetched for adoption even if the sink filters it out)
        if (arts.length) files.set(d.internalId, arts);
        emitProgress(ds.id, [{ internalId: d.internalId, stream: sid, record: bakeLearned(d) }]); // live: the card shows the real date now
        setStatus(t('status_downloading', [String(++n), String(eligible.length), sink.id])); // live counter
        pending.push(d);
        if (pending.length >= CHUNK) await flushChunk(); // checkpoint
      } else {
        pending = eligible.slice(); // record-only send: no per-doc fetch, deliver the manifest in one flush
      }
      await flushChunk(); // final partial chunk (whole batch for record-only / the download sink)
    }
    // A 0-sent result now means the sink's category filter rejected everything (the docs were passed in, so
    // they were definitely "found"). Log it for Report a problem.
    if (!sent) pushDiag(adapter.id, { phase: 'send', message: `send → 0 sent · picked=${found} accepted=${accepted} sink='${sink.id}'` });
    await appendLog({ kind: 'manual', datasource: ds.id, sink: sink.id, status: 'ok', count: sent });
    await badgeCount(sent);
    setStatus(t('status_done', [name, String(sent)]));
    return { status: 'done', sent, found, accepted };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    pushDiag(adapter.id, { phase: 'send', message: msg });
    await appendLog({ kind: 'manual', datasource: ds.id, sink: sink.id, status: 'error', error: msg });
    await badgeError(); setStatus(t('status_error', [name, msg.slice(0, 80)]));
    return { status: 'error', error: msg };
  }
}

async function runRoute(ds, adapter, sink, opts = {}) {
  const kind = opts.kind || 'auto';
  const base = { kind, datasource: ds.id, sink: sink.id, ...(opts.origin ? { origin: opts.origin } : {}) };
  const name = adapter.name || ds.adapter;
  await badgeWorking();
  setStatus(t('status_listing', [name]));
  try {
    const auth = await authFor(adapter);
    // NOT ready if there's no session, OR a required captured context value is still missing — the SPA
    // captures a JWT on the login page BEFORE the user finishes authenticating (so e.g. the DNI needed for
    // {ctx.dni} isn't there yet). Running now would send an empty/wrong value (CaixaBank: groups 401 "Nif
    // incorrecto"). Treat it as no-session → the sweep opens the login page; retries once fully logged in.
    const ctxMissing = ((adapter.auth && adapter.auth.context) || []).some((c) => !(auth && auth.ctx && auth.ctx[c.name] != null && auth.ctx[c.name] !== ''));
    if (!auth || ctxMissing) { await appendLog({ ...base, status: 'nosession' }); await badgeClear(); setStatus(t('status_nosession', [name])); return { status: 'nosession' }; }
    // Auto/sweep runs unattended (a tab is already open post-login) → reuse it. A MANUAL/interactive run (the
    // Archive's "Save") opens the site tab if none exists, so the page-context fetch inherits the session.
    const net = opts.net || (opts.interactive ? await ensureSiteFetch(adapter, { open: true }) : await resolveSiteFetch(adapter));
    adapter = withBrandHost(adapter, net); // brand (multi-TLD) source → api.host = the domain the user's tab is on
    const delivered = await deliveredSet(ds.id, sink.id);
    // A source may expose several outputs (streams×formats). Auto-mode delivers the outputs THIS sink accepts
    // (a typed consumer that wants only `transaction` gets just that stream). List once per stream (formats
    // share the items); fetch each doc's selected-format artifacts; record per stream store key.
    const outs = outputsForSink(adapter, sink, sinkAcceptsSource);
    const streamIds = [...new Set(outs.map((o) => o.stream))];
    const fmtsFor = (sid) => outs.filter((o) => o.stream === sid).map((o) => o.format);
    let totalNew = 0;
    for (const sid of streamIds) {
      if (opts.signal && opts.signal.aborted) break; // Sync-all was stopped
      const eff = resolveOutput(adapter, sid); const sk = storeKeyOf(adapter.id, sid); const fmts = fmtsFor(sid);
      // onProgress → live per-page status (visible in an open popup during a Sync-all sweep). signal → stop.
      // ds.groups = the user's saved account allow-list (grouped sources): auto/sweep only ever touch those.
      const all = await listInventory(eff, auth, net, { groupId: opts.groupId, groups: (ds.groups && ds.groups.length) ? ds.groups : undefined, signal: opts.signal, onProgress: (p) => setStatus(t('status_listing_page', [name, String(p.page || ''), String((p.docs && p.docs.length) || '')])) }); // opts.groupId → one account; opts.groups → allow-list
      const fresh = opts.force ? all : all.filter((d) => !delivered[d.internalId]); // force → re-deliver everything
      // Deliver oldest → newest (the list comes newest-first) — files written + manifest appended + store
      // recorded chronologically, matching the manual send. Covers auto, sweep and external collect.
      const eligible = fresh.filter((d) => acceptsDoc(sink, d))
        .sort((a, b) => ((a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0));
      if (!eligible.length) continue;
      setStatus(t('status_fetching', [String(eligible.length), name]));
      const files = new Map();
      let fetched = 0, anyArts = false, pending = [];
      // Checkpoint every CHUNK docs so a long download persists incrementally (sink files + delivery ledger +
      // canonical-store records). An interruption — Stop, the service worker recycling, the browser closing —
      // then loses at most one chunk instead of the whole batch (the reported "500 downloaded, metadata lost").
      // writeToSink/recordDelivered/markDelivered all read-merge-write, so repeated flushes accumulate safely.
      // The ephemeral `download` (ZIP) sink can't be chunked (one flush = one ZIP) → single final flush.
      const CHUNK = sink.type === 'download' ? Infinity : 25;
      const flushChunk = async () => {
        if (!pending.length) return;
        const batch = pending; pending = [];
        setStatus(t('status_sending', [String(batch.length), sink.id]));
        await writeToSink(sink, batch, files, { service: adapter.service || ds.adapter, source: sk, ext: documentExt(eff) || 'pdf', interactive: !!opts.interactive });
        await markDelivered(ds.id, sink.id, batch.map((d) => d.internalId));
        for (const d of batch) d.record = bakeLearned(d); // persist the real date/amount learned from the detail
        emitProgress(ds.id, batch.map((d) => ({ internalId: d.internalId, stream: sid, record: d.record, delivered: sink.id }))); // live: flip cards to "saved"
        try { await recordDelivered(sk, batch, { source: adapter.id, schema: eff.schema, srcVersion: adapter.version }); } catch (e) { /* store is best-effort */ } // write-through to the canonical store
        try { await rememberDocMeta(adapter.id, batch.map((d) => ({ internalId: d.internalId, date: /^\d{4}-\d{2}-\d{2}/.test(d.date || '') ? d.date : undefined, total: typeof d.total === 'number' ? d.total : undefined, returnStatus: d.returnStatus || undefined }))); } catch (e) { /* best-effort */ }
        for (const d of batch) files.delete(d.internalId); // bound memory across a large sweep
        totalNew += batch.length;
      };
      for (const d of eligible) {
        if (opts.signal && opts.signal.aborted) break; // stop fetching mid-source (already-flushed chunks are safe)
        const arts = [];
        for (const fmt of (fmts.length ? fmts : [''])) {
          const oeff = resolveOutput(adapter, sid + (fmt ? '/' + fmt : ''));
          const kinds = artifactKinds(oeff).filter((k) => sinkAcceptsArtifact(sink, k));
          const avail = artifactKinds(oeff, d); // per-doc: drops the document (e.g. invoice PDF) if this doc lacks it
          for (const k of kinds) {
            if (!avail.some((a) => a.kind === k.kind)) continue; // this ticket has no such artifact (no invoice) → skip cleanly
            const rec = recordingNet(net); // remember which request fails inside a multi-step fetch
            try { arts.push(await fetchArtifact(oeff, auth, d, rec.net, renderPage, k.kind)); }
            catch (e) {
              const msg = (e && e.message) || String(e);
              if (!/no document for this (item|source)|no PDF for this source/i.test(msg)) { // benign skip → not a failure
                pushDiag(adapter.id, { phase: 'document', output: sid, kind: k.kind, item: d.date || d.internalId, message: msg, method: rec.ref.last && rec.ref.last.method, url: rec.ref.last && rec.ref.last.url, status: rec.ref.last && rec.ref.last.status });
              }
            }
          }
        }
        await adoptRealDate(adapter, sid, auth, d, arts, net); // real date/amount from the JSON detail (fetched for adoption even if the sink filters it out)
        if (arts.length) { files.set(d.internalId, arts); anyArts = true; }
        emitProgress(ds.id, [{ internalId: d.internalId, stream: sid, record: bakeLearned(d) }]); // live date/amount on the card
        setStatus(t('status_downloading', [String(++fetched), String(eligible.length), name])); // live counter (long sources)
        pending.push(d);
        if (pending.length >= CHUNK) await flushChunk(); // checkpoint this chunk before fetching the next
      }
      await flushChunk(); // final partial chunk (and, for the download sink, the whole batch at once)
      // A stream that HAS a document (a statement PDF) but produced none from any eligible item — a silent
      // "0 documents" the contributor can't explain. Record it so "Report a problem" surfaces it.
      if (!anyArts && eligible.length && documentExt(eff)) {
        pushDiag(adapter.id, { phase: 'document', output: sid, message: 'listed ' + eligible.length + ' item(s) but none produced a document (download failed or the document template did not resolve)' });
      }
    }
    if (!totalNew) { await appendLog({ ...base, status: 'none', new: 0 }); await badgeClear(); setStatus(t('status_none', [name])); return { status: 'done', new: 0 }; }

    await appendLog({ ...base, status: 'ok', new: totalNew });
    if (kind === 'auto') notify(t('notify_new', [String(totalNew), sink.id])); // external collect: the tab + activity log are the surface (no extra notification)
    await badgeCount(totalNew);
    setStatus(t('status_done', [name, String(totalNew)])); // $NAME$: $N$ (placeholders are name=$1, n=$2)
    return { status: 'done', new: totalNew };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    // An anti-bot challenge (DataDome/Cloudflare/Akamai) on the API isn't a real failure — the site needs an
    // interactive check the background can't solve. Log it softly and DON'T fire an error notification; it
    // retries when the user is on the site with a solved challenge (or runs it manually).
    if (/captcha-delivery|datadome|geo\.captcha|interstitial|challenge-platform|__cf_chl|cf-browser-verification|just a moment|akam[ai]/i.test(msg)) {
      // Show the CAPTCHA to the user (core thesis: they resolve challenges live). Open the interstitial URL
      // from the response, else the source site; solving it sets the anti-bot cookie so the next run passes.
      const curl = challengeUrlOf(msg);
      try { await chrome.tabs.create({ url: curl || siteBaseUrl(adapter), active: true }); } catch (e2) {}
      await appendLog({ ...base, status: 'challenged' });
      notify(t('notify_challenge', [name]));
      await badgeClear();
      setStatus(t('status_challenged', [name]));
      return { status: 'challenged' };
    }
    await appendLog({ ...base, status: 'error', error: msg });
    if (kind === 'auto') notify(t('notify_autoerr', [msg]));
    await badgeError();
    setStatus(t('status_error', [name, msg.slice(0, 80)]));
    return { status: 'error', error: msg };
  }
}

// ---- Download planner (scheduled source→sink deliveries) --------------------------------------------
// Per-schedule runtime state (nextRun / retries / opened flag) kept OUT of config so arming doesn't churn it.
const SCHED_STATE = 'habeas:schedstate';
const RETRY_MS = 15 * 60 * 1000;   // wait between retries when a run couldn't complete (no session / error)
const MAX_RETRIES = 4;             // ~1h of retries, then give up until the next scheduled occurrence
async function getSchedState() { try { return (await chrome.storage.local.get(SCHED_STATE))[SCHED_STATE] || {}; } catch (e) { return {}; } }
async function setSchedState(s) { try { await chrome.storage.local.set({ [SCHED_STATE]: s }); } catch (e) {} }
const nowMs = () => Date.now();

// Arm one chrome.alarm per enabled schedule at its target time (a pending retry, else the stored nextRun,
// else the next occurrence). Chrome fires an overdue `when` on browser start → that IS the catch-up.
async function syncSchedules() {
  if (!chrome.alarms) return;
  const cfg = await getConfig();
  const schedules = (cfg.schedules || []).filter((s) => s && s.enabled && s.datasource && s.sink && s.spec);
  const state = await getSchedState();
  const live = new Set();
  for (const s of schedules) {
    const st = state[s.id] || {};
    let target = st.retryAt || st.nextRun;
    if (!target) { target = nextOccurrence(s.spec, nowMs()); st.nextRun = target; }
    if (target == null) continue;               // malformed spec → skip
    state[s.id] = st; live.add(s.id);
    try { await chrome.alarms.create('sched:' + s.id, { when: Math.max(target, nowMs() + 1000) }); } catch (e) {}
  }
  // Drop alarms + state for schedules that no longer exist / were disabled.
  try { for (const a of await chrome.alarms.getAll()) { const id = String(a.name).startsWith('sched:') && a.name.slice(6); if (id && !live.has(id)) chrome.alarms.clear(a.name); } } catch (e) {}
  for (const id of Object.keys(state)) if (!live.has(id)) delete state[id];
  await setSchedState(state);
}

// A schedule fired (or a browser start replayed an overdue alarm). Run it, then re-arm: next occurrence on
// success, or a retry in RETRY_MS while it couldn't complete (no live session / error), bounded by MAX_RETRIES.
async function onScheduleAlarm(id) {
  const cfg = await getConfig();
  const s = (cfg.schedules || []).find((x) => x.id === id);
  if (!s || !s.enabled) { await chrome.alarms.clear('sched:' + id).catch(() => {}); return; }
  const adapters = await getAdapters();
  const ds = (cfg.datasources || []).find((d) => d.id === s.datasource);
  const adapter = ds && adapters[ds.adapter];
  const sink = (cfg.sinks || []).find((k) => k.id === s.sink);
  const state = await getSchedState(); const st = state[id] || {};
  const arm = async (when) => { st.nextRun = when; try { await chrome.alarms.create('sched:' + id, { when: Math.max(when, nowMs() + 1000) }); } catch (e) {} };
  const scheduleNext = async () => { st.retryAt = null; st.retries = 0; st.opened = false; const nx = nextOccurrence(s.spec, nowMs()); await arm(nx); };
  if (!ds || !adapter || !sink) { await scheduleNext(); state[id] = st; return setSchedState(state); } // dangling → skip to next

  await appendLog({ kind: 'schedule', datasource: s.datasource, sink: s.sink, status: 'running' });
  let res;
  try { res = await runRoute(ds, adapter, sink, { kind: 'schedule' }); }
  catch (e) { res = { status: 'error', error: (e && e.message) || String(e) }; }
  st.lastRun = nowMs(); st.lastStatus = res.status;

  if (res.status === 'done') { await scheduleNext(); }
  else {
    // Couldn't complete. If there's no live session, open the source tab ONCE (so the user can log in) and
    // notify; further retries just re-run silently against the now-open tab. Retry every RETRY_MS.
    if (res.status === 'nosession' && !st.opened) {
      st.opened = true;
      try { await ensureSiteFetch(adapter, { open: true }); } catch (e) {}
      notify(t('notify_sched_login', [adapter.name || ds.adapter]));
    }
    st.retries = (st.retries || 0) + 1;
    if (st.retries <= MAX_RETRIES) { st.retryAt = nowMs() + RETRY_MS; await arm(st.retryAt); }
    else { notify(t('notify_sched_gaveup', [adapter.name || ds.adapter])); await scheduleNext(); }
  }
  state[id] = st; await setSchedState(state);
}

// ---------------------------------------------------------------------------
// External hooks: a third-party site proposes a workflow (consent-gated) and later requests
// collection for a granted route. Origin-bound + consent are enforced here and in exthooks.js.
// ---------------------------------------------------------------------------
const COLLECT_DEBOUNCE_MS = 30 * 1000;

function senderOrigin(sender) {
  if (!sender) return '';
  if (sender.origin) return sender.origin; // Chrome MV3: authoritative page origin of the content script
  try { return new URL(sender.url).origin; } catch (e) { return ''; }
}

const siteBaseUrl = (adapter) => {
  const m = (adapter.match && adapter.match[0]) || ('https://' + hostOf(adapter) + '/*');
  const base = m.replace(/^([a-z]+:\/\/[^/]+).*/i, '$1');
  return (base || 'https://' + hostOf(adapter)) + '/';
};

async function handleExt(api, payload, origin) {
  if (!origin) return { ok: false, status: 'error', error: 'no origin' };
  if (api === 'propose-workflow') return proposeWorkflow(origin, payload);
  if (api === 'collect') return collectForGrant(origin, payload);
  if (api === 'list-groups') return listGroupsForGrant(origin, payload);
  if (api === 'list-sources') return listSourcesForOrigin(origin);
  if (api === 'status') return extStatus(origin);
  return { ok: false, status: 'error', error: 'unknown api' };
}

// A site asks which sources the user currently has enabled. Consent-gated per origin (a lightweight
// `kind:'list-sources'` grant, no route), returning PUBLIC metadata only — never accounts or data. First ask
// opens the consent screen and returns `pending`; the site retries once approved. Re-prompts are deduped per
// origin so polling can't spawn a stack of consent windows.
async function listSourcesForOrigin(origin) {
  const grant = (await grantsForOrigin(origin)).find((g) => g.kind === 'list-sources');
  if (grant) {
    await touchGrant(grant.id, new Date().toISOString());
    const [cfg, adapters] = await Promise.all([getConfig(), getAdapters()]);
    return { ok: true, status: 'ok', sources: enabledSources(cfg, adapters) };
  }
  const pendKey = 'extls:' + origin;
  const o = await chrome.storage.session.get(pendKey);
  const pend = o[pendKey];
  // Only suppress a re-open while the consent window is STILL open (so polling can't stack windows). If the
  // user closed it without deciding, a fresh click re-opens it — no 5-minute lockout that made the button
  // silently do nothing. (authorize.js clears pendKey on allow/deny.)
  if (pend && pend.windowId != null) {
    try { await chrome.windows.get(pend.windowId); return { ok: true, status: 'pending' }; } catch (e) { /* window gone → open a new one */ }
  }
  const reqId = 'ls_' + crypto.randomUUID();
  await chrome.storage.session.set({ ['extreq:' + reqId]: { kind: 'list-sources', origin, at: Date.now() } });
  const url = chrome.runtime.getURL('src/ui/authorize.html?req=' + reqId);
  let win = null;
  try { win = await chrome.windows.create({ url, type: 'popup', width: 540, height: 520 }); }
  catch (e) { try { await chrome.tabs.create({ url }); } catch (e2) {} }
  await chrome.storage.session.set({ [pendKey]: { reqId, at: Date.now(), windowId: (win && win.id != null) ? win.id : null } });
  await appendLog({ kind: 'authz-listsources', origin, status: 'pending' });
  return { ok: true, status: 'pending' };
}

// Mask a sensitive group value (IBAN, card number) before exposing it to a consumer that only needs
// to let the user pick an account: keep the first/last 4, hide the middle.
function maskValue(v) { const s = String(v == null ? '' : v); return s.length <= 8 ? s : s.slice(0, 4) + ' **** ' + s.slice(-4); }

// A granted consumer asks which groups (accounts/cards) the source exposes, so it can let the user
// pick before requesting collection. Grant-gated + origin-bound; enumerates in the source's tab
// (in-session), masks the fields the adapter marks sensitive; returns metadata only, never items.
async function listGroupsForGrant(origin, payload) {
  const grant = await getGrant(payload && payload.grantId);
  if (!grantUsableBy(grant, origin)) return { ok: false, status: 'denied', error: 'no grant for this origin' };
  const cfg = await getConfig();
  const adapters = await getAdapters();
  const ds = cfg.datasources.find((d) => d.id === grant.datasourceId && d.enabled);
  const adapter = ds && adapters[ds.adapter];
  if (!adapter) return { ok: false, status: 'error', error: 'route not found' };
  if (!adapter.api.groups) return { ok: true, status: 'ok', groups: [] }; // this source has no groups
  const net = await resolveSiteFetch(adapter).catch(() => null);
  if (!net || !(await hasLiveSession(adapter))) {
    // Need a logged-in tab on the source site to enumerate in-session; open one and ask to retry.
    const tab = await chrome.tabs.create({ url: siteBaseUrl(adapter), active: true }).catch(() => null);
    injectCapture(tab && tab.id);
    await appendLog({ kind: 'ext-groups', origin, source: ds.id, status: 'needs-login' });
    return { ok: true, status: 'needs-login' };
  }
  const auth = await authFor(adapter);
  const groups = await listGroups(adapter, auth, net);
  const fieldNames = Object.keys(adapter.api.groups.fields || {});
  const mask = adapter.api.groups.mask || [];
  const out = groups.map((g) => { const o = {}; for (const k of fieldNames) o[k] = mask.includes(k) ? maskValue(g[k]) : g[k]; return o; });
  await touchGrant(grant.id, new Date().toISOString());
  await appendLog({ kind: 'ext-groups', origin, source: ds.id, status: 'ok', count: out.length });
  return { ok: true, status: 'ok', groups: out };
}

async function proposeWorkflow(origin, payload) {
  const v = validateProposal(origin, payload);
  if (!v.ok) return { ok: false, status: 'denied', error: v.error };
  const adapters = await getAdapters();
  if (!adapters[payload.source]) return { ok: false, status: 'denied', error: 'unknown source' };
  const reqId = 'r_' + crypto.randomUUID();
  await chrome.storage.session.set({ ['extreq:' + reqId]: { origin, source: payload.source, sink: v.sink, filter: v.filter || null, at: Date.now() } });
  const url = chrome.runtime.getURL('src/ui/authorize.html?req=' + reqId);
  try { await chrome.windows.create({ url, type: 'popup', width: 540, height: 560 }); }
  catch (e) { try { await chrome.tabs.create({ url }); } catch (e2) {} }
  await appendLog({ kind: 'authz', origin, source: payload.source, status: 'pending' });
  return { ok: true, status: 'pending', requestId: reqId };
}

async function extStatus(origin) {
  const grants = await grantsForOrigin(origin);
  return { ok: true, grants: grants.map((g) => ({ grantId: g.id, source: g.datasourceId, sinkOrigin: originHost(origin) })) };
}

async function collectForGrant(origin, payload) {
  const grant = await getGrant(payload && payload.grantId);
  if (!grantUsableBy(grant, origin)) return { ok: false, status: 'denied', error: 'no grant for this origin' };
  const dk = 'collectLast:' + grant.id;
  const o = await chrome.storage.session.get(dk);
  if (o[dk] && Date.now() - o[dk] < COLLECT_DEBOUNCE_MS) return { ok: true, status: 'debounced' };
  await chrome.storage.session.set({ [dk]: Date.now() });
  await touchGrant(grant.id, new Date().toISOString());

  const cfg = await getConfig();
  const adapters = await getAdapters();
  const ds = cfg.datasources.find((d) => d.id === grant.datasourceId && d.enabled);
  const adapter = ds && adapters[ds.adapter];
  const sink = cfg.sinks.find((s) => s.id === grant.sinkId);
  if (!adapter || !sink) return { ok: false, status: 'error', error: 'route not found' };

  const host = hostOf(adapter);
  const live = await hasLiveSession(adapter);
  // ALWAYS a dedicated tab on the source site (needed for the in-session, page-context fetch).
  // Background if a session is live; foregrounded (login prompt) if the user must authenticate.
  const tab = await chrome.tabs.create({ url: siteBaseUrl(adapter), active: !live }).catch(() => null);
  injectCapture(tab && tab.id); // best-effort: capture the JWT/csrf as the user browses/logs in

  const groupId = payload && payload.group != null ? payload.group : undefined; // collect one account only
  if (live) { runExternalCollect(grant, ds, adapter, sink, tab && tab.id, groupId); return { ok: true, status: 'collecting' }; }
  await addPending(host, { grantId: grant.id, tabId: tab && tab.id, origin, groupId });
  await appendLog({ kind: 'ext-collect', origin, source: ds.id, status: 'needs-login' });
  return { ok: true, status: 'needs-login' };
}

const hasLiveSession = (adapter) => hasAuth(adapter);

function injectCapture(tabId) {
  if (!tabId || !chrome.scripting) return;
  try {
    // hook in the MAIN world (CSP-proof), bridge in the ISOLATED world.
    chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/hook.js'], world: 'MAIN' }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/bridge.js'] }).catch(() => {});
  } catch (e) {}
}

async function runExternalCollect(grant, ds, adapter, sink, tabId, groupId) {
  const net = tabId ? await resolveSiteFetch(adapter).catch(() => null) : null;
  return runRoute(ds, adapter, sink, { kind: 'ext', origin: grant.origin, interactive: true, net: net || undefined, groupId });
}

async function addPending(host, entry) {
  const key = 'extpending:' + host;
  const o = await chrome.storage.session.get(key);
  const arr = (o[key] || []).filter((x) => x.grantId !== entry.grantId);
  arr.push(entry);
  await chrome.storage.session.set({ [key]: arr });
}

async function runPendingExternalCollects(host) {
  const key = 'extpending:' + host;
  const o = await chrome.storage.session.get(key);
  const arr = o[key] || [];
  if (!arr.length) return;
  await chrome.storage.session.remove(key);
  const cfg = await getConfig();
  const adapters = await getAdapters();
  for (const entry of arr) {
    const grant = await getGrant(entry.grantId);
    if (!grant) continue;
    const ds = cfg.datasources.find((d) => d.id === grant.datasourceId && d.enabled);
    const adapter = ds && adapters[ds.adapter];
    const sink = cfg.sinks.find((s) => s.id === grant.sinkId);
    if (adapter && sink) runExternalCollect(grant, ds, adapter, sink, entry.tabId, entry.groupId);
  }
}

function notify(message) {
  try { chrome.notifications.create({ type: 'basic', iconUrl: 'icon-128.png', title: 'Habeas', message }); }
  catch (e) {}
}

// Let a contributor know — without opening Settings — when the Habeas team replies to one of their
// handoffs. Polls their own submissions (by pseudonymous id), notifies ONCE per new team reply, and
// stashes the unread count so the popup can surface it too. Silent if the API is unreachable.
async function checkContribReplies() {
  try {
    const sub = await getSubmitter();
    if (!sub || !sub.id) return;
    const list = await getMyHandoffs(sub.id);
    const seen = sub.seen || {};
    const unread = list.filter((h) => h.lastFrom === 'team' && h.lastAt && (!seen[h.id] || seen[h.id] < h.lastAt));
    await chrome.storage.local.set({ 'habeas:contribunread': unread.length }); // popup reads this
    const o = await chrome.storage.local.get('habeas:contribnotified');
    const notified = o['habeas:contribnotified'] || {};
    const fresh = unread.filter((h) => !notified[h.id] || notified[h.id] < h.lastAt);
    if (fresh.length) {
      notify(t('contrib_notify') || 'The Habeas team replied to your contribution');
      const next = { ...notified }; for (const h of unread) next[h.id] = h.lastAt;
      await chrome.storage.local.set({ 'habeas:contribnotified': next });
    }
  } catch (e) {}
}
