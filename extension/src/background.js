// Background service worker. Stores captured session auth (never on disk) and, on the
// user's own login, runs any `mode: auto` route: list -> only NEW (per ledger) -> send to
// a SW-runnable sink (drive/http) -> mark -> notify. This is triggered by the user's own
// login, not a background job while they're away.
import { chrome } from './lib/ext.js';
import { getConfig, saveConfig } from './lib/config.js';
import { registerCapture, hasCapturePermissions } from './lib/capture.js';
import { loadAuth, hasAuth, capturePathAllowed } from './lib/authstore.js';
import { pushDiag, recordingNet, pushReqCtx, redactReqVal as rcRedactVal } from './lib/diag.js';
import { deliveredSet, markDelivered, appendLog, rememberDocMeta } from './lib/state.js';
import { applyStoredConfigIfNewer, writeSnapshotIfChanged } from './lib/configsync.js';
import { syncVaultIfUnlocked } from './lib/secretsync.js';
import { listInventory, listGroups, artifactKinds, fetchArtifact, documentExt } from './runtime/inventory.js';
import { resolveSiteFetch, ensureSiteFetch, recoverSession, clearSiteCookies, withBrandHost, findSiteTab, foregroundTab } from './lib/pagefetch.js';
import { retrieveDelivered, isRetrievable } from './lib/retrieve.js';
import { driveCache } from './sinks/drive.js';
import { dropboxCache } from './sinks/dropbox.js';
import { renderPage, isChallenged, challengeUrlOf } from './lib/render.js';
import { writeToSink, readSinkRecords } from './sinks/sinks.js';
import { recordDelivered, putItems, getRecords } from './lib/store.js';
import { getHandle } from './lib/fs.js';
import { nextOccurrence } from './lib/schedule.js';
import { acceptsDoc, sinkAcceptsArtifact, sinkAcceptsSource, bakeLearned, adoptDetailMeta, groupLabelOf } from './sinks/format.js';
import { outputsForSink, outputsOf, resolveOutput, storeKeyOf } from './lib/outputs.js';
import { storeIdOf, migrateBrandDomains } from './lib/instances.js';
import { getAdapters } from './adapters/index.js';
import { hasConsent } from './lib/consent.js';
import { siteMatches } from './lib/sitematch.js';
import { badgeWorking, badgeCount, badgeError, badgeClear, badgeRecording, setStatus } from './lib/badge.js';
import { t } from './lib/i18n.js';
import { getSubmitter } from './lib/submitter.js';
import { getMyHandoffs } from './registry/client.js';
import { validateProposal, validateSink, originHost, enabledSources, sinkIdForOrigin } from './lib/exthooks.js';
import { getGrant, grantsForOrigin, grantUsableBy, touchGrant, revokeGrant } from './lib/grants.js';
import { migrateSinkHeaders } from './lib/sinkheaders.js';
import { runStoreMigration } from './lib/migrate.js';
import { autoDebounced, retainAutoDebounce, autoBackoffMs, needsPageContext, isLoginNavigation, isReadyNavigation, needsTabEscalation, wantsCookieReset, loginErrorNeedsCookieReset, sweepSinkId, orderedSweepSources, AUTO_CAPTURE_SETTLE_MS } from './lib/autosync.js';

// On startup, (re)register the in-session capture bridge for every enabled source (dynamic content
// scripts can be dropped on an extension update). Idempotent; needs the host permission already granted.
(async () => {
  try {
    const cfg = await getConfig();
    const adapters = await getAdapters();
    for (const d of (cfg.datasources || []).filter((x) => x.enabled)) { const a = adapters[d.adapter]; if (a) await registerCapture(a); }
    // One-time: fan a legacy "one datasource pinned to several countries (brandDomains[])" into per-country instances.
    if (migrateBrandDomains(cfg, adapters)) await saveConfig(cfg);
    // One-time: re-normalize stored records to the current schema (bank balanceAfter/valueDate; Trade Republic
    // investment@2) and reset read/write sink ledgers so the next Sync re-pushes the corrected records.
    runStoreMigration(adapters).then((r) => {
      if (r && r.records) appendLog({ kind: 'migrate', ok: true, msg: `Re-normalized ${r.records} stored record(s) across ${r.changed.length} source(s); reset ${r.resets} delivery ledger(s).` });
    }).catch(() => {});
  } catch (e) {}
  // Cross-device config: adopt a NEWER config snapshot from the (cloud-backed) canonical store, so this machine
  // picks up the account/output/schedule settings + destinations configured elsewhere. Best-effort; the cascade
  // below (capture/schedule re-arm on the resulting config change) applies the merged config.
  applyStoredConfigIfNewer().catch(() => {});
  // One-time: encrypt any pairing-token headers left plaintext in config by older versions.
  migrateSinkHeaders().catch(() => {});
  syncWebRequestCapture();
  syncLoginErrorWatch(); // watch a resetCookies source's login page for its "corrupted cookies" status (WiZink 400)
  syncLearnAssetCapture().catch(() => {}); // (re)arm record-mode document capture if a recording is in progress
  syncLearnBadge(false).catch(() => {});   // …and restore REC on the toolbar (never clearing another feature's badge)
  syncSchedules().catch(() => {}); // (re)arm the download planner's alarms; overdue ones fire the catch-up
  runAutoMaintenance().catch(() => {}); // version-gated: recover real data from cloud destinations, once, unattended
  try { chrome.alarms.create('contrib:poll', { periodInMinutes: 20 }); } catch (e) {} // poll for team replies to the user's handoffs
  checkContribReplies(); // check once on startup so a reply that arrived while closed notifies promptly
})();
// Re-sync the webRequest capture filter + the schedule alarms when the config changes.
let __snapTimer = 0;
function scheduleConfigSnapshot() { try { clearTimeout(__snapTimer); } catch (e) {} __snapTimer = setTimeout(() => { writeSnapshotIfChanged().catch(() => {}); }, 3000); }
let __vaultTimer = 0;
// A local secret changed → if the portable vault is unlocked this session, re-encrypt + re-upload it (debounced),
// so a credential added/updated on this device reaches the others. No-op when the vault is locked/disabled.
function scheduleVaultSync() { try { clearTimeout(__vaultTimer); } catch (e) {} __vaultTimer = setTimeout(() => { syncVaultIfUnlocked().catch(() => {}); }, 3000); }
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && (ch['habeas:config'] || ch['habeas:sources'])) { syncWebRequestCapture(); syncLoginErrorWatch(); }
  if (area === 'local' && ch['habeas:config']) { syncSchedules().catch(() => {}); scheduleConfigSnapshot(); } // push the change to the store for other devices (debounced; writeSnapshotIfChanged skips the apply echo)
  if (area === 'local' && ch['habeas:secrets']) scheduleVaultSync();
  if (area === 'local' && ch['habeas:learn']) { syncLearnAssetCapture().catch(() => {}); syncLearnBadge().catch(() => {}); }
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
  const cur = o[key] || { merged: {}, byPath: {}, ctx: {}, at: {} };
  cur.merged = { ...cur.merged, ...headers };
  cur.at = cur.at || {};
  const nowIso = new Date().toISOString(); // when this token/headers were (re)captured — so a 401 can show its age
  cur.at.__merged = nowIso;
  if (path) { cur.byPath[path] = { ...(cur.byPath[path] || {}), ...headers }; cur.at[path] = nowIso; }
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

// ---- resetCookies: wipe on a login-page error status (WiZink) -----------------------------------------
// WiZink corrupts its OWN session cookies; when they're bad, GETting /login returns HTTP 400. We watch the
// login page of every enabled `resetCookies` source that declares `auth.resetCookiesOnLoginStatus` and, on
// that status, wipe the site's cookies and reload — giving the user a clean sign-in. Guards against a loop:
// reload ONLY when we actually cleared cookies (a non-cookie 400 clears 0 → no reload), and at most once per
// tab per 15 s. Restricted to GET main_frame so submitting bad credentials (a POST) never wipes the session.
const loginResetAt = new Map(); // tabId -> ts of the last reset (best-effort; SW recycle just relaxes the guard)
async function onLoginErrorResponse(details) {
  try {
    if (details.type !== 'main_frame' || details.method !== 'GET' || details.tabId == null || details.tabId < 0) return;
    const prev = loginResetAt.get(details.tabId);
    if (prev && Date.now() - prev < 15000) return;
    const cfg = await getConfig();
    const adapters = await getAdapters();
    for (const d of (cfg.datasources || []).filter((x) => x.enabled)) {
      const a = adapters[d.adapter];
      if (!loginErrorNeedsCookieReset(a, details.url, details.statusCode)) continue;
      const cleared = await clearSiteCookies(a.domain || hostOf(a));
      if (cleared > 0) {
        loginResetAt.set(details.tabId, Date.now());
        try { await chrome.tabs.reload(details.tabId); } catch (e) {}
        try { await appendLog({ kind: 'auth', datasource: d.id, status: 'cookies_cleared', new: cleared }); } catch (e) {}
      }
      break; // one source per login host
    }
  } catch (e) {}
}
// (Re)register the login-error watcher, scoped to the login paths of resetCookies sources that opt in.
async function syncLoginErrorWatch() {
  if (!(chrome.webRequest && chrome.webRequest.onCompleted)) return;
  try { chrome.webRequest.onCompleted.removeListener(onLoginErrorResponse); } catch (e) {}
  const cfg = await getConfig();
  const adapters = await getAdapters();
  const urlSet = new Set();
  for (const d of (cfg.datasources || []).filter((x) => x.enabled)) {
    const a = adapters[d.adapter], au = a && a.auth;
    if (!au || !au.resetCookies || au.resetCookiesOnLoginStatus == null || !au.loginUrl) continue;
    try { const u = new URL(au.loginUrl); urlSet.add(`*://${u.host}${u.pathname}*`); } catch (e) {}
  }
  const urls = [...urlSet];
  if (!urls.length) return;
  try { chrome.webRequest.onCompleted.addListener(onLoginErrorResponse, { urls, types: ['main_frame'] }); } catch (e) {}
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
// Show REC on the toolbar icon for as long as record mode is armed, and say so in the tooltip. The
// recorder's own live panel sits in the Settings tab, which the user is NOT looking at while they browse
// the site being recorded — so without this the whole recording is silent from where they actually are.
async function syncLearnBadge(clearIfIdle = true) {
  const o = await chrome.storage.local.get('habeas:learn');
  const l = o['habeas:learn'];
  if (l && l.active && l.domain) { badgeRecording(); setStatus(chrome.i18n.getMessage('badge_recording', [l.domain]) || ('recording ' + l.domain)); }
  // The badge is shared with sync results, so only clear it on a real stop — not on a service-worker
  // restart that merely happens to find no recording in progress.
  else if (clearIfIdle) { badgeClear(); setStatus(''); }
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
      // No live session used to be the end of it — but "save this source here" mostly means documents
      // the archive already holds, and refusing to move those because the bank happens to be logged out
      // was needless. Fall back to a store-only send: files come from whatever other destination has
      // them, and the source is never contacted. Only what is genuinely new still needs a session.
      if (r && r.status === 'nosession' && !msg.force) {
        const picked = await pickStoredDocs(ds, adapter, sink).catch(() => []);
        if (picked.length) {
          const sr = await sendStoredDocs(ds, adapter, sink, picked, { noOpen: true, noSource: true, signal: startOp() });
          if (sr && sr.sent) return { ok: true, ...sr, fromStore: true };
        }
      }
      return { ok: true, ...r };
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true; // async response
  }
  if (msg.type === 'habeas:archiveCopy' && msg.sink) { // Settings → "copy my archive to another destination"
    (async () => {
      const cfg = await getConfig();
      const sink = (cfg.sinks || []).find((s) => s.id === msg.sink);
      if (!sink) return { ok: false, error: 'unknown sink' };
      const adapters = await getAdapters();
      const signal = startOp();
      const r = await runArchiveCopy(cfg, adapters, sink, {
        signal,
        originId: msg.from || '',
        // Progress rides the same storage channel the Archive already listens on, so the Settings page
        // gets live counts without a port that a sleeping service worker would drop.
        onProgress: (p) => setStatus(p.phase === 'source' ? t('status_fetching', [String(p.found), p.name]) : t('status_sending', [String(p.sent), sink.id])),
      });
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
    // A brand INSTANCE only auto-runs on ITS country's tab: logging into amazon.es must not trigger the
    // amazon.com instance (each has its own store + schedule). No triggerUrl (capture-only) → don't gate.
    if (ds.brandDomain && Array.isArray(adapter.domains) && triggerUrl) { let h = ''; try { h = new URL(triggerUrl).host; } catch (e) {} if (h && !(h === ds.brandDomain || h.endsWith('.' + ds.brandDomain))) continue; }
    // The navigation that triggered us is the source's own login page → the user isn't authenticated yet.
    // Skip (a session-gated prelude would 400) and wait for the post-login navigation to fire us again.
    if (triggerUrl && isLoginNavigation(adapter, triggerUrl)) continue;
    // Some SPAs expose a source's data only once a specific view has finished loading, yet fire capturable
    // requests on earlier screens (ING is "too eager" — its data lives behind the PFM product view). When the
    // source declares auth.readyUrl, wait until the trigger URL is that view before running.
    if (!isReadyNavigation(adapter, triggerUrl)) continue;
    if (!(await hasConsent(adapter))) continue; // community/cross-domain source not yet consented
    // For a source with an observable bearer, require that the token has actually been captured before
    // running: the bearer only exists after login, so this is the robust "the user is logged in" signal —
    // it keeps auto-run (from EITHER trigger) from firing mid-login and disturbing a fragile bank session,
    // even when the source declares no loginUrl for the page-based guard above.
    if (hasObservableBearer(adapter) && !(await hasAuth(adapter))) continue;
    const sink = cfg.sinks.find((s) => s.id === route.sink);
    if (!sink || sink.type === 'download' || sink.type === 'local-folder') continue; // need a page
    const dk = 'autoLast:' + route.id;
    const cdk = 'autoCd:' + route.id;
    const st = await chrome.storage.session.get([dk, cdk]);
    if (autoDebounced(st[dk], Date.now())) continue;
    // A repeatedly-failing source is in a growing backoff cooldown → skip until it expires (stops the ING 401 loop).
    if (st[cdk] && st[cdk].until && Date.now() < st[cdk].until) continue;
    // Don't run on a Cloudflare/anti-bot interstitial — the real session isn't available yet. When the
    // challenge passes, the page reloads → onUpdated fires again → this runs on the real site.
    if (tabId != null) { if (challenge === null) challenge = await isChallenged(tabId); if (challenge) return; }
    running.add(route.id);
    await chrome.storage.session.set({ [dk]: Date.now() });
    // On a completed run: hold the 10-min debounce + clear the failure backoff. On a transient/auth failure:
    // release the debounce (a real login can retry) BUT bump a growing backoff cooldown so a persistently-failing
    // source (ING's 401 loop) stops hammering — the first failure still retries at once, each further one waits longer.
    runRoute(ds, adapter, sink)
      .then((res) => onAutoResult(route.id, res && res.status))
      .catch(() => onAutoResult(route.id, 'error'))
      .finally(() => running.delete(route.id));
  }
}
// Record an auto-run's outcome: a completed run clears the failure backoff; a failure releases the run debounce
// (a fresh login can retry) and bumps a growing per-route cooldown so a source that keeps failing stops hammering.
async function onAutoResult(routeId, status) {
  const dk = 'autoLast:' + routeId, cdk = 'autoCd:' + routeId;
  if (retainAutoDebounce(status)) { await chrome.storage.session.remove(cdk); return; } // success → clear the backoff
  await chrome.storage.session.remove(dk); // failure → drop the debounce so a real login retries (the cooldown still gates it)
  const n = (((await chrome.storage.session.get(cdk))[cdk] || {}).n || 0) + 1;
  await chrome.storage.session.set({ [cdk]: { n, until: Date.now() + autoBackoffMs(n) } });
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
    // A source can fan out to SEVERAL auto destinations now → collect ALL its auto-route sinks (not just one).
    const autoSinksBy = {}; (cfg.routes || []).filter((r) => r.mode === 'auto').forEach((r) => { (autoSinksBy[r.datasource] = autoSinksBy[r.datasource] || []).push(r.sink); });
    const favs = (await chrome.storage.local.get('habeas:favsink'))['habeas:favsink'] || {};
    const def = (await chrome.storage.local.get('habeas:defaultsink'))['habeas:defaultsink'] || '';
    const swRunnable = (s) => !!s && s.type !== 'download' && s.type !== 'local-folder';
    await badgeWorking();
    let sources = 0, totalNew = 0, needLogin = 0, errors = 0, noSink = 0;
    // Only the sources the user opted INTO the sweep (ds.sweep !== false), in their chosen order (ds.sweepOrder).
    for (const ds of orderedSweepSources(cfg.datasources)) {
      if (signal.aborted) break; // stopped by the user
      const adapter = adapters[ds.adapter];
      if (!adapter || !(await hasConsent(adapter))) continue;
      // ALL of this source's auto destinations (fallback to its favorite / the global default when it has none).
      const sinkIds = (autoSinksBy[ds.id] && autoSinksBy[ds.id].length) ? [...new Set(autoSinksBy[ds.id])] : [sweepSinkId(ds.id, {}, favs, def)];
      const sinks = sinkIds.map((id) => cfg.sinks.find((s) => s.id === id)).filter(swRunnable);
      if (!sinks.length) { noSink++; continue; }
      sources++;
      setStatus(t('status_listing', [adapter.name || ds.adapter]));
      await appendLog({ kind: 'sweep', datasource: ds.id, status: 'listing' }); // incremental: "syncing X…" in the log
      let deliveredHere = false;
      for (const sink of sinks) {
        if (signal.aborted) break;
        let res = await runRoute(ds, adapter, sink, { kind: 'sweep', signal }); // unattended; each instance pins its own country
        if (signal.aborted) break; // don't open login tabs / escalate after a stop
        if (res.status === 'nosession' || wantsCookieReset(adapter, res)) {
          // No captured session, OR a resetCookies source (WiZink) failed on auth with corrupted cookies →
          // WIPE its cookies and open/navigate the login page so the user CAN authenticate. Stop trying the
          // remaining sinks for this source (they'd all hit the same dead session); resume on capture. Without
          // the wipe, a resetCookies source would just tab-retry the same bad cookies below and never recover.
          try { await recoverSession(adapter); } catch (e) {}
          needLogin++; break;
        } else if (needsTabEscalation(res)) {
          // Session may be live but there's no tab (anti-bot/CSRF) → open the site tab and retry in-session.
          const net = await ensureSiteFetch(adapter, { open: true }).catch(() => null);
          if (net) res = await runRoute(ds, adapter, sink, { kind: 'sweep', net, interactive: true });
        }
        if (res.status === 'done') { if (!deliveredHere) { totalNew += res.new || 0; deliveredHere = true; } } // count NEW once per source (the store is shared)
        else if (res.status === 'challenged') { needLogin++; break; }
        else if (res.status === 'error') errors++;
      }
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
    const sk = storeKeyOf(storeIdOf(ds, adapter), o.stream);
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

// Version-gated, UNATTENDED maintenance: recover real data (dates, amounts, details) from what was already
// delivered to a CLOUD/readable destination — the same as the Archive's "Recover data from destination", but run
// once automatically at startup for every enabled source, so a cloud-backed archive self-heals without the user
// clicking. Gated by MAINT_KEY===MAINT_VER (bump MAINT_VER to re-run for everyone). Throttled + keep-alive so a
// long recovery outlives SW idle; if it's cut short the marker isn't set and it resumes next startup. Purely
// reads back what's already there — never re-downloads from the source, never touches the network of a source.
const MAINT_KEY = 'habeas:automaint';
const MAINT_VER = 1;
async function runAutoMaintenance() {
  let o; try { o = await chrome.storage.local.get(MAINT_KEY); } catch (e) { o = {}; }
  if (o[MAINT_KEY] === MAINT_VER) return;
  const cfg = await getConfig();
  const readable = (cfg.sinks || []).filter((s) => ['dropbox', 'webdav', 's3', 'local-folder', 'drive'].includes(s.type));
  if (!readable.length) return; // no readable destination → nothing to recover; don't mark (re-check once one exists)
  const adapters = await getAdapters();
  keepAlive();
  try {
    for (const ds of (cfg.datasources || []).filter((d) => d.enabled)) {
      const adapter = adapters[ds.adapter]; if (!adapter) continue;
      try { await reconcileFromDelivered(ds, adapter); } catch (e) { /* best-effort per source */ }
      await new Promise((r) => setTimeout(r, 400)); // throttle between sources — don't hammer the destination
    }
    try { await chrome.storage.local.set({ [MAINT_KEY]: MAINT_VER }); } catch (e) {}
    setStatus('');
  } finally { stopKeepAlive(); }
}

// Deliver a SPECIFIC set of already-stored documents (hand-picked in the Archive) to a sink. Unlike runRoute
// (which LISTS new docs), this works straight from the canonical store — the user chose exact items to push
// somewhere. The normalized record always delivers (manifest); a per-item file is re-fetched when the source can
// still produce it and there's a live session (best-effort — old items whose PDF template needs list-only fields
// just deliver record-only, same contract as the popup's store-loaded send).
// Positive per-record acknowledgment: an http consumer may reply { accepted: [id…] } — only those
// docs enter the delivery ledger (the rest stay undelivered and retry on the next sync). A sink
// that doesn't reply with `accepted` (file sinks, older consumers) confirms by not throwing: the
// whole batch is marked, as before.
function ackAccepted(res, batch) {
  if (!res || !Array.isArray(res.accepted)) return batch;
  const ok = new Set(res.accepted.map(String));
  return batch.filter((d) => ok.has(String(d.internalId)));
}

async function sendStoredDocs(ds, adapter, sink, picked, opts = {}) {
  const name = adapter.name || ds.adapter;
  const found = (picked || []).length;
  if (!found) return { status: 'done', sent: 0, found: 0, accepted: 0 };
  await badgeWorking();
  setStatus(t('status_fetching', [String(found), name]));
  try {
    const auth = await authFor(adapter);
    const wantsDocs = opts.force || outputsOf(adapter).some((o) => artifactKinds(resolveOutput(adapter, o.id)).length);
    // GENERAL RULE: only touch the SOURCE when a file isn't already available elsewhere. The records came from the
    // archive; each file may already sit in a retrievable store it was delivered to (Dropbox/WebDAV/S3 — the
    // default sink or any other) → read it back from there instead of re-fetching from the source (which would
    // open the site and need its live session). local-folder needs a page handle the service worker lacks; the
    // TARGET sink is skipped; opts.force ("Re-download from site") bypasses retrieval to fetch fresh.
    const cfg = await getConfig();
    // local-folder is absent because the service worker has no directory handle — only a page does, so a
    // folder-backed archive is copied page-side instead (see the Settings migration).
    const SW_RETRIEVABLE = new Set(['dropbox', 'webdav', 's3', 'drive']);
    // opts.originId pins the copy to ONE destination: chosen explicitly, the operation reads as
    // "A → B" and cannot silently pull a file from somewhere the user did not name. Left unset,
    // every readable destination is tried, which is what handles an archive spread across two.
    const stores = opts.force ? [] : (cfg.sinks || []).filter((s) =>
      s.id !== sink.id && SW_RETRIEVABLE.has(s.type) && (!opts.originId || s.id === opts.originId));
    // One cache per remote store for the whole send. Drive resolves names to ids, so without this every
    // file costs an extra lookup and a few thousand documents run into rate limits. Dropbox is worse: a
    // read there is a full download, so probing document by document pulls the entire archive over the
    // wire and the pass simply stops finishing once the archive is big enough. One folder listing each.
    const dcache = driveCache(), bcache = dropboxCache();
    const retrieveArt = async (d, ext) => {
      const rec = { ...(d.record || {}), internalId: d.internalId, date: d.date ?? (d.record && d.record.date), group: d.group ?? (d.record && d.record.group) };
      for (const st of stores) { try { const r = await retrieveDelivered(st, adapter, rec, ext, { only: true, driveCache: dcache, dropboxCache: bcache }); if (r && r.blob) return { blob: r.blob, ext: r.ext || ext }; } catch (e) {} }
      return null;
    };
    // The source page-fetch, opened LAZILY — only when a file genuinely can't be read back from a store. So a
    // send of documents already in Dropbox never opens the source. undefined = unresolved, null = resolved-none.
    let net;
    const ensureNet = async () => {
      // opts.noSource: the archive copy promises never to contact the source at all. noOpen only stops a
      // NEW tab being opened — an already-open one would still be used, and then "copied from your other
      // destination" would quietly become "re-fetched from the site", which is not what was reported.
      if (opts.noSource) return null;
      if (net === undefined) { net = auth ? await ensureSiteFetch(adapter, { open: wantsDocs && !opts.noOpen, ds }).catch(() => null) : null; adapter = withBrandHost(adapter, net, ds); }
      return net;
    };
    // The RECORDS were passed in from the Archive page (which already read the store) → no store re-read here,
    // so a Dropbox/folder-backed archive that the service worker can't list still works. Group by stream.
    const byStream = new Map();
    for (const dd of picked) { const s = (dd && dd.stream) || ''; (byStream.get(s) || byStream.set(s, []).get(s)).push(dd); }
    let sent = 0, accepted = 0, rejectedCount = 0;
    for (const [sid, list] of byStream) {
      if (opts.signal && opts.signal.aborted) break; // Stop pressed
      const eff = resolveOutput(adapter, sid); const sk = storeKeyOf(storeIdOf(ds, adapter), sid);
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
        const res = await writeToSink(sink, batch, files, { service: adapter.service || ds.adapter, source: sk, ext: documentExt(eff) || 'pdf', interactive: true });
        const acked = ackAccepted(res, batch); // positive per-record confirmation: only acked docs enter the ledger
        await markDelivered(ds.id, sink.id, acked.map((d) => d.internalId));
        for (const d of batch) d.record = bakeLearned(d);
        emitProgress(ds.id, acked.map((d) => ({ internalId: d.internalId, stream: sid, record: d.record, delivered: sink.id }))); // live: flip cards to "saved"
        try { await recordDelivered(sk, batch, { source: adapter.id, schema: eff.schema, srcVersion: adapter.version }); } catch (e) { /* store best-effort */ }
        try { await rememberDocMeta(storeIdOf(ds, adapter), batch.map((d) => ({ internalId: d.internalId, date: /^\d{4}-\d{2}-\d{2}/.test(d.date || '') ? d.date : undefined, total: typeof d.total === 'number' ? d.total : undefined, exts: [...new Set((files.get(d.internalId) || []).map((a) => a && a.ext).filter(Boolean))] }))); } catch (e) {}
        for (const d of batch) files.delete(d.internalId); // bound memory
        sent += acked.length;
        rejectedCount += batch.length - acked.length;
      };
      if (wantsDocs) for (const d of eligible) {
        if (opts.signal && opts.signal.aborted) break; // Stop pressed — stop before the next doc (flushed chunks are safe)
        const arts = [];
        for (const fmt of (fmts.length ? fmts : [''])) {
          const oeff = resolveOutput(adapter, sid + (fmt ? '/' + fmt : ''));
          const kinds = artifactKinds(oeff).filter((k) => sinkAcceptsArtifact(sink, k));
          const avail = artifactKinds(oeff, d); // per-doc: skip a document kind this item lacks
          for (const k of kinds) {
            if (!avail.some((a) => a.kind === k.kind)) continue;
            const ext = k.ext || documentExt(oeff) || 'pdf';
            let art = await retrieveArt(d, ext); // 1. read the already-delivered file back from a store (Dropbox…)
            if (!art) {                          // 2. not stored anywhere → fetch from the SOURCE (opens the site lazily)
              const nf = await ensureNet();
              if (nf) { const rc = recordingNet(nf);
                try { art = await fetchArtifact(oeff, auth, d, rc.net, renderPage, k.kind); }
                catch (e) { const msg = (e && e.message) || String(e); if (!/no document for this (item|source)|no PDF for this source/i.test(msg)) pushDiag(adapter.id, { phase: 'document', output: sid, item: d.date || d.internalId, message: msg, method: rc.ref.last && rc.ref.last.method, url: rc.ref.last && rc.ref.last.url, status: rc.ref.last && rc.ref.last.status }); } }
            }
            if (art) arts.push(art);
          }
        }
        if (net) await adoptRealDate(adapter, sid, auth, d, arts, net); // only if we actually opened the source (a retrieved file already carries the stored date)
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
    return { status: 'done', sent, found, accepted, rejected: rejectedCount };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    pushDiag(adapter.id, { phase: 'send', message: msg });
    await appendLog({ kind: 'manual', datasource: ds.id, sink: sink.id, status: 'error', error: msg, ...errFields(e) });
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
  let netRef = null; // the page fetcher's tab — surfaced ONLY if a USER-initiated run then FAILS on auth (re-login)
  try {
    const auth = await authFor(adapter);
    // NOT ready if there's no session, OR a required captured context value is still missing — the SPA
    // captures a JWT on the login page BEFORE the user finishes authenticating (so e.g. the DNI needed for
    // {ctx.dni} isn't there yet). Running now would send an empty/wrong value (CaixaBank: groups 401 "Nif
    // incorrecto"). Treat it as no-session → the sweep opens the login page; retries once fully logged in.
    const ctxMissing = ((adapter.auth && adapter.auth.context) || []).some((c) => !(auth && auth.ctx && auth.ctx[c.name] != null && auth.ctx[c.name] !== ''));
    if (!auth || ctxMissing) { await appendLog({ ...base, status: 'nosession' }); await badgeClear(); setStatus(t('status_nosession', [name])); return { status: 'nosession' }; }
    // The source's OPTIONAL host permissions can be silently revoked by a browser/add-on update (a Firefox
    // temporary-add-on reload wipes them) — the page-context fetch would then die with a cryptic "Missing host
    // permission for the tab". The background can't re-request (no user gesture), so DETECT the loss, log it as
    // its own soft status, and tell the user to re-grant it in Settings (one click there re-requests). Not a hard
    // error, doesn't escalate (opening a tab can't fix a permission), and the notification opens Settings.
    if (!(await hasCapturePermissions(adapter))) {
      await appendLog({ ...base, status: 'noperm' }); await badgeError();
      if (kind === 'auto') notify(t('notify_noperm', [name]), 'noperm');
      setStatus(t('status_noperm', [name]));
      return { status: 'noperm' };
    }
    // Auto/sweep runs unattended (a tab is already open post-login) → reuse it. A MANUAL/interactive run (the
    // Archive's "Save") opens the site tab if none exists, so the page-context fetch inherits the session.
    // A brand source instance is pinned to a SINGLE country (ds.brandDomain) — its own store, ledger and
    // schedule. An unattended run (no tab) opens that country; an interactive run still follows the user's tab.
    const countryDs = { brandDomain: opts.brandDomain || ds.brandDomain };
    const net = opts.net || (opts.interactive ? await ensureSiteFetch(adapter, { open: true, ds: countryDs }) : await resolveSiteFetch(adapter, countryDs));
    netRef = net;
    // A page-context source (cross-origin API behind a WAF that checks Origin — ING) can ONLY be fetched through
    // its open site tab; a direct extension fetch would 401 at the edge. With a live session but no tab, report
    // 'notab' (NOT a hard failure): the sweep escalates by opening the site tab and retrying in-page, and a manual
    // run already opens the tab. Never leak a cross-origin SW fetch that would come back as a misleading 401.
    if (!net && needsPageContext(adapter)) { await appendLog({ ...base, status: 'notab' }); await badgeClear(); setStatus(t('status_notab', [name])); return { status: 'notab' }; }
    adapter = withBrandHost(adapter, net, countryDs); // brand (multi-TLD) source → api.host = the tab's domain, or the pinned country
    const brandCountry = (Array.isArray(adapter.domains) ? adapter.domains.find((d) => (adapter.api.host || '').includes(d)) : null) || null; // tag records with the country they came from
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
      const eff = resolveOutput(adapter, sid); const sk = storeKeyOf(storeIdOf(ds, adapter), sid); const fmts = fmtsFor(sid);
      // onProgress → live per-page status (visible in an open popup during a Sync-all sweep). signal → stop.
      // ds.groups = the user's saved account allow-list (grouped sources): auto/sweep only ever touch those.
      const all = await listInventory(eff, auth, net, { groupId: opts.groupId, groups: (ds.groups && ds.groups.length) ? ds.groups : undefined, signal: opts.signal, onProgress: (p) => setStatus(t('status_listing_page', [name, String(p.page || ''), String((p.docs && p.docs.length) || '')])) }); // opts.groupId → one account; opts.groups → allow-list
      if (brandCountry) for (const d of all) if (d.record) d.record.country = brandCountry; // which country each record came from (mixed multi-country store)
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
        const wres = await writeToSink(sink, batch, files, { service: adapter.service || ds.adapter, source: sk, ext: documentExt(eff) || 'pdf', interactive: !!opts.interactive });
        const acked = ackAccepted(wres, batch); // positive per-record confirmation: only acked docs enter the ledger
        await markDelivered(ds.id, sink.id, acked.map((d) => d.internalId));
        for (const d of batch) d.record = bakeLearned(d); // persist the real date/amount learned from the detail
        emitProgress(ds.id, acked.map((d) => ({ internalId: d.internalId, stream: sid, record: d.record, delivered: sink.id }))); // live: flip cards to "saved"
        try { await recordDelivered(sk, batch, { source: adapter.id, schema: eff.schema, srcVersion: adapter.version }); } catch (e) { /* store is best-effort */ } // write-through to the canonical store
        try { await rememberDocMeta(storeIdOf(ds, adapter), batch.map((d) => ({ internalId: d.internalId, date: /^\d{4}-\d{2}-\d{2}/.test(d.date || '') ? d.date : undefined, total: typeof d.total === 'number' ? d.total : undefined, returnStatus: d.returnStatus || undefined, exts: [...new Set((files.get(d.internalId) || []).map((a) => a && a.ext).filter(Boolean))] }))); } catch (e) { /* best-effort */ }
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
    await appendLog({ ...base, status: 'error', error: msg, ...errFields(e) });
    if (kind === 'auto') notify(t('notify_autoerr', [msg]));
    await badgeError();
    setStatus(t('status_error', [name, msg.slice(0, 80)]));
    // The op FAILED on auth (401/403 — session expired / not authenticated) on a USER-initiated run → surface the
    // source's tab so the user can re-login. Never for an unattended run, and never for a transient 401 that
    // recovered (we only reach here on a hard failure).
    if ((kind === 'manual' || kind === 'ext') && netRef && netRef.tabId != null && /\b(401|403)\b/.test(msg)) foregroundTab(netRef.tabId);
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

// Pull the structured bits off a thrown HTTP error (set by runtime/inventory.js) so the activity log can render a
// clean, actionable message + the exact request that failed, instead of a raw HTML body dump.
function errFields(e) {
  const f = {};
  if (e && e.http != null) f.http = e.http;
  if (e && e.op) f.op = e.op;
  if (e && e.url) f.url = e.url;
  // Whether the JWT we replayed was itself expired — the difference between "your session ended" and "the saved
  // short-lived bank token had lapsed even though the browser session is fine". Lets the log say the right thing.
  if (e && e.token && e.token.exp != null) {
    const now = e.token.now || Math.floor(Date.now() / 1000);
    f.tokenState = (e.token.exp - now) >= 0 ? 'valid' : 'expired';
  }
  if (e && e.authForm) f.authForm = e.authForm; // the SHAPE of the authorization we replayed (jwt / bearer-nonjwt / basic / none)
  return f;
}

const siteBaseUrl = (adapter) => {
  const m = (adapter.match && adapter.match[0]) || ('https://' + hostOf(adapter) + '/*');
  const base = m.replace(/^([a-z]+:\/\/[^/]+).*/i, '$1');
  return (base || 'https://' + hostOf(adapter)) + '/';
};

async function handleExt(api, payload, origin) {
  if (!origin) return { ok: false, status: 'error', error: 'no origin' };
  if (api === 'propose-workflow') return proposeWorkflow(origin, payload);
  if (api === 'register-sink') return registerSink(origin, payload);
  if (api === 'collect') return collectForGrant(origin, payload);
  if (api === 'list-groups') return listGroupsForGrant(origin, payload);
  if (api === 'list-sources') return listSourcesForOrigin(origin);
  if (api === 'status') return extStatus(origin);
  if (api === 'show-document') return showDocumentForOrigin(origin, payload);
  if (api === 'revoke-grant') return revokeGrantForOrigin(origin, payload);
  return { ok: false, status: 'error', error: 'unknown api' };
}

// The sources CURRENTLY ROUTED to the caller's OWN sink — regardless of how the route was created
// (external-hooks propose/consent OR configured by hand in Habeas's Settings). Origin-bound: only
// routes whose sink is the origin's own sink; PUBLIC metadata only (source id/name/service/categories/
// trust + route mode), never accounts, documents or data. No cross-origin leak: a site only ever sees
// what feeds its own sink. Surfaced as `status.routes` so a consumer gets the full delivery picture
// (not just its grant-backed routes) in the same poll it already makes.
// Show a document the consumer was ALREADY GIVEN THE RECORD OF, in Habeas's own viewer.
//
// A consumer that reconciles bank movements needs the LIST of invoices and not the invoices: Cuentamo
// wants Amazon's records to match against, and emphatically does not want five thousand PDFs. But when
// the user asks "what was this charge?", somebody has to be able to show the thing. This is that.
//
// The document never crosses. Nothing is returned but an acknowledgement — Habeas opens its own viewer,
// in its own tab, and what appears there is between the extension and the person looking at it. Which is
// why this can be permitted at all: there is no channel out.
//
// Bounded by what was already delivered to this origin's own sink. A consumer may ask to display a
// record it holds; it may not go fishing through documents the user never routed to it. And the refusal
// is the ONE piece of information this can leak, so it must never distinguish "not yours" from "does not
// exist": both answer the same way, or the API becomes an oracle for guessing what somebody owns.
async function showDocumentForOrigin(origin, payload) {
  const denied = { ok: false, status: 'denied' };            // identical for absent and for not-yours
  const sinkId = sinkIdForOrigin(origin);
  if (!sinkId) return denied;                                 // not a paired integration at all
  const source = String((payload && payload.source) || '');
  const internalId = payload && payload.internalId;
  if (!source || internalId == null) return denied;
  const base = source.split(':')[0];

  const cfg = await getConfig();
  const ds = (cfg.datasources || []).find((d) => d.id === base || d.adapter === base);
  if (!ds) return denied;
  const delivered = await deliveredSet(ds.id, sinkId).catch(() => ({}));
  if (!delivered[internalId]) return denied;                  // the record was never routed here

  // Rendered from a destination that can actually be read back — never the consumer's own, which is
  // typically an HTTP endpoint and holds nothing retrievable.
  const from = (cfg.sinks || []).find((s) => s.id !== sinkId && isRetrievable(s));
  if (!from) return denied;
  const url = chrome.runtime.getURL('src/ui/docview.html')
    + `?sink=${encodeURIComponent(from.id)}&src=${encodeURIComponent(base)}&id=${encodeURIComponent(String(internalId))}`
    + (payload && payload.ext ? `&ext=${encodeURIComponent(String(payload.ext))}` : '');
  await chrome.tabs.create({ url, active: true });
  await appendLog({ kind: 'ext-show', datasource: ds.id, sink: sinkId, status: 'ok', count: 1 });
  return { ok: true, status: 'shown' };
}

async function routesForOrigin(origin) {
  const sinkId = sinkIdForOrigin(origin);
  const [cfg, adapters] = await Promise.all([getConfig(), getAdapters()]);
  const seen = new Set();
  const sources = [];
  for (const r of (cfg.routes || [])) {
    if (!r || r.sink !== sinkId || !r.datasource || seen.has(r.datasource)) continue;
    seen.add(r.datasource);
    const ds = (cfg.datasources || []).find((d) => d.id === r.datasource);
    const a = adapters[(ds && ds.adapter) || r.datasource];
    sources.push({
      source: r.datasource,
      name: (a && (a.name || a.id)) || r.datasource,
      service: (a && (a.service || a.id)) || r.datasource,
      categories: a && Array.isArray(a.categories) ? a.categories.slice() : [],
      trust: (a && a.trust) || 'community',
      mode: r.mode || 'external',
      enabled: !!(ds && ds.enabled),
    });
  }
  return sources;
}

// A consumer may revoke ITS OWN grant (pure scope reduction — no consent needed; origin-bound like
// everything else). The route's datasource/sink config stays in Habeas (it's the user's); only this
// origin's capability to trigger it goes away.
async function revokeGrantForOrigin(origin, payload) {
  const grant = await getGrant(payload && payload.grantId);
  if (!grantUsableBy(grant, origin)) return { ok: false, status: 'denied', error: 'no grant for this origin' };
  await revokeGrant(grant.id);
  await appendLog({ kind: 'ext-revoke', origin, source: grant.datasourceId || grant.kind || '', status: 'ok' });
  return { ok: true, status: 'ok' };
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
  // A streamed source (ING) declares api.groups per STREAM, not at the top level — resolve every
  // grouped stream, same rule as the popup's account picker (checking + savings + deposits…).
  const gAdapters = [];
  if (adapter.api && adapter.api.groups) gAdapters.push(adapter);
  for (const s of adapter.streams || []) { const eff = resolveOutput(adapter, s.id); if (eff.api && eff.api.groups) gAdapters.push(eff); }
  if (!gAdapters.length) return { ok: true, status: 'ok', groups: [] }; // this source has no groups
  const allow = (ds.groups || []).map(String); // the user's saved account allow-list (popup picker)
  // Serve the last live enumeration from cache FIRST (groups change rarely; no bank contact, no
  // tab). A consumer passes `refresh: true` to force a fresh in-session enumeration.
  if (!(payload && payload.refresh) && Array.isArray(ds.groupsCache) && ds.groupsCache.length) {
    const groups = allow.length ? ds.groupsCache.filter((g) => allow.includes(String(g.id))) : ds.groupsCache;
    await touchGrant(grant.id, new Date().toISOString());
    await appendLog({ kind: 'ext-groups', origin, source: ds.id, status: 'cached', count: groups.length });
    return { ok: true, status: 'ok', cached: true, groups };
  }
  const net = await resolveSiteFetch(adapter, ds).catch(() => null);
  if (!net || !(await hasLiveSession(adapter))) {
    // No live session. Serve the user's SAVED account selection (ds.groups/ds.groupLabels, curated in
    // Habeas's own picker) — enough for a consumer to offer the mapping — before falling back to an
    // interactive login.
    if (allow.length) {
      const labels = Array.isArray(ds.groupLabels) && ds.groupLabels.length === allow.length ? ds.groupLabels : null;
      const groups = allow.map((id, i) => ({ id, name: (labels && labels[i]) || id }));
      await appendLog({ kind: 'ext-groups', origin, source: ds.id, status: 'cached', count: groups.length });
      return { ok: true, status: 'ok', cached: true, groups };
    }
    // Need a logged-in tab on the source site to enumerate in-session; surface an existing one
    // (or open one) and ask to retry — never stack a second tab on a single-session bank.
    let tab = await findSiteTab(adapter, ds).catch(() => null);
    if (tab) await surfaceTab(tab);
    else tab = await chrome.tabs.create({ url: siteBaseUrl(adapter), active: true }).catch(() => null);
    injectCapture(tab && tab.id);
    await appendLog({ kind: 'ext-groups', origin, source: ds.id, status: 'needs-login' });
    return { ok: true, status: 'needs-login' };
  }
  const auth = await authFor(adapter);
  const seen = new Set(); const out = [];
  for (const ga of gAdapters) {
    let groups; try { groups = await listGroups(ga, auth, net); } catch (e) { continue; } // one stream failing must not kill the rest
    const fieldNames = Object.keys(ga.api.groups.fields || {});
    const mask = ga.api.groups.mask || [];
    for (const g of groups) {
      const id = String(g.id == null ? '' : g.id);
      if (seen.has(id)) continue; seen.add(id);
      if (allow.length && !allow.includes(id)) continue; // respect the user's account filter — excluded accounts are not revealed
      const o = {}; for (const k of fieldNames) o[k] = mask.includes(k) ? maskValue(g[k]) : g[k];
      o.label = groupLabelOf(g); // the record.group label — lets a consumer relate groups to delivered records
      out.push(o);
    }
  }
  // Persist the enumeration so later list-groups calls are served without contacting the bank.
  try { ds.groupsCache = out; ds.groupsCacheAt = new Date().toISOString(); await saveConfig(cfg); } catch (e) {}
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

// Register the caller as a DESTINATION (sink) with NO source and NO grant: the site just declares
// "you can send data here", and the user routes whichever sources they want to it later, from
// Settings (push model). Origin-bound + consent-gated exactly like a proposal, but it never grants
// the site any pull capability. The consent screen (authorize.js, kind:'register-sink') upserts the
// sink on approval. Re-registering (e.g. to rotate the token) is fine — same origin-bound sink id.
async function registerSink(origin, payload) {
  const v = validateSink(origin, payload);
  if (!v.ok) return { ok: false, status: 'denied', error: v.error };
  const reqId = 'sk_' + crypto.randomUUID();
  await chrome.storage.session.set({ ['extreq:' + reqId]: { kind: 'register-sink', origin, sink: v.sink, at: Date.now() } });
  const url = chrome.runtime.getURL('src/ui/authorize.html?req=' + reqId);
  try { await chrome.windows.create({ url, type: 'popup', width: 540, height: 520 }); }
  catch (e) { try { await chrome.tabs.create({ url }); } catch (e2) {} }
  await appendLog({ kind: 'authz-sink', origin, status: 'pending' });
  return { ok: true, status: 'pending', requestId: reqId };
}

async function extStatus(origin) {
  // Route grants only: a capability grant (kind:'list-sources') has no source/sink and would
  // surface at the consumer as a phantom connection with an empty source.
  const grants = (await grantsForOrigin(origin)).filter((g) => g.datasourceId);
  // `routes` = the full delivery config pointed at this sink (incl. routes wired by hand in Settings,
  // which have no grant). `grants` stays the ACTIONABLE list (each carries a grantId for collect/revoke).
  const routes = await routesForOrigin(origin);
  // `sink` = whether this origin is registered as a destination at all (via register-sink OR a past
  // proposal). Lets a consumer confirm pairing even before any source is routed to it.
  const cfg = await getConfig();
  const s = (cfg.sinks || []).find((x) => x.id === sinkIdForOrigin(origin));
  const sink = s ? { registered: true, ...(s.name ? { name: s.name } : {}) } : { registered: false };
  return {
    ok: true,
    grants: grants.map((g) => ({ grantId: g.id, source: g.datasourceId, sinkOrigin: originHost(origin) })),
    routes,
    sink,
  };
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

  // Archive-only sync: deliver NEW stored docs (per this sink's ledger) straight from the canonical
  // store, WITHOUT contacting the source — no tab, no session, no login. `group` narrows to one
  // account via the cached enumeration's record label.
  if (payload && payload.fromStore) {
    const groupId = payload.group != null ? String(payload.group) : undefined;
    const entry = groupId && Array.isArray(ds.groupsCache) ? ds.groupsCache.find((g) => String(g.id) === groupId) : null;
    // Awaited: an archive-only send is fast (store read + record-only POSTs), and returning the
    // counts lets the consumer tell "delivered N" from "nothing new in the archive". `force: true`
    // ignores the delivery ledger and re-sends the WHOLE archive (safe: the consumer replies with
    // per-record `accepted` and dedupes on its side) — the recovery path when records were once
    // marked delivered but the consumer dropped them.
    const r = await runExternalStoreSend(ds, adapter, sink, { label: entry && entry.label ? String(entry.label) : undefined, force: !!payload.force });
    return { ok: r.status !== 'error', status: r.status === 'error' ? 'error' : 'done', fromStore: true, sent: r.sent || 0, found: r.found || 0, rejected: r.rejected || 0, ...(r.error ? { error: r.error } : {}) };
  }

  const host = hostOf(adapter);
  const live = await hasLiveSession(adapter);
  // A tab on the source site is needed (the in-session, page-context fetch) — but REUSE one already
  // sitting on the site instead of stacking a new tab per collect: single-session banks (ING) show a
  // login (and may drop the live session) when a second tab opens, and the page-fetch could then pick
  // the wrong tab. Background if a session is live; foregrounded (login) if the user must authenticate.
  let tab = await findSiteTab(adapter, ds).catch(() => null);
  if (tab) { if (!live) await surfaceTab(tab); }
  else tab = await chrome.tabs.create({ url: siteBaseUrl(adapter), active: !live }).catch(() => null);
  injectCapture(tab && tab.id); // best-effort: capture the JWT/csrf as the user browses/logs in

  const groupId = payload && payload.group != null ? payload.group : undefined; // collect one account only
  if (live) { runExternalCollect(grant, ds, adapter, sink, tab && tab.id, groupId); return { ok: true, status: 'collecting' }; }
  await addPending(host, { grantId: grant.id, tabId: tab && tab.id, origin, groupId });
  await appendLog({ kind: 'ext-collect', origin, source: ds.id, status: 'needs-login' });
  return { ok: true, status: 'needs-login' };
}

const hasLiveSession = (adapter) => hasAuth(adapter);

// Bring an existing tab to the front (window + tab) — used when the user must log in there.
async function surfaceTab(tab) {
  if (!tab || tab.id == null) return;
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
  try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) {}
}

function injectCapture(tabId) {
  if (!tabId || !chrome.scripting) return;
  try {
    // hook in the MAIN world (CSP-proof), bridge in the ISOLATED world.
    chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/hook.js'], world: 'MAIN' }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/bridge.js'] }).catch(() => {});
  } catch (e) {}
}

async function runExternalCollect(grant, ds, adapter, sink, tabId, groupId) {
  const net = tabId ? await resolveSiteFetch(adapter, ds).catch(() => null) : null;
  return runRoute(ds, adapter, sink, { kind: 'ext', origin: grant.origin, interactive: true, net: net || undefined, groupId });
}

// Archive-only external sync: read every stream's stored records, keep the ones this sink hasn't
// delivered yet (per ledger), optionally narrow to one account (its record.group label, resolved
// from the cached enumeration), and hand them to sendStoredDocs with noOpen (record-only unless a
// site tab already happens to be open — the source is never contacted on purpose).
// Which stored documents this route still owes a sink. The delivery ledger IS the cursor: everything in
// the archive minus everything already delivered here, recomputed each time. That is what makes a long
// copy resumable without any new state — an interruption loses at most the chunk in flight.
async function pickStoredDocs(ds, adapter, sink, { label, force } = {}) {
  const sid0 = storeIdOf(ds, adapter);
  const delivered = force ? {} : await deliveredSet(ds.id, sink.id).catch(() => ({}));
  const streams = [...new Set(outputsOf(adapter).map((o) => o.stream))];
  // Respect the user's account selection (popup's "Cuentas" picker): the archive
  // holds records from EVERY account ever collected, but a store-send must only
  // deliver the accounts the user picked — same allow-list list-groups + collect
  // honor. Records carry `record.group` = the account LABEL (groupLabelOf).
  const allowLabels = Array.isArray(ds.groupLabels) && ds.groupLabels.length ? new Set(ds.groupLabels.map(String)) : null;
  const picked = [];
  for (const sid of streams) {
    const sk = storeKeyOf(sid0, sid);
    let recs; try { recs = await getRecords(sk, { delivered }); } catch (e) { continue; }
    for (const r of recs || []) {
      if (!r || r.internalId == null) continue;
      const grp = String(r.group || '');
      if (label) { if (grp !== label) continue; }            // one account only
      else if (allowLabels && grp && !allowLabels.has(grp)) continue; // excluded account (no group → allowed, e.g. integrated statement)
      picked.push({ internalId: r.internalId, record: r, stream: sid });
    }
  }
  return picked;
}

async function runExternalStoreSend(ds, adapter, sink, { label, force } = {}) {
  const picked = await pickStoredDocs(ds, adapter, sink, { label, force });
  if (!picked.length) {
    // Nothing new for this route — tell the consumer apart from a delivery (found: 0).
    await appendLog({ kind: 'ext-store', datasource: ds.id, sink: sink.id, status: 'ok', count: 0 });
    return { status: 'done', sent: 0, found: 0, accepted: 0 };
  }
  return sendStoredDocs(ds, adapter, sink, picked, { noOpen: true });
}

// Copy the whole archive — every source — into one destination, without ever contacting a source.
// Files come from whichever OTHER destination already holds them; a document that no readable
// destination has is skipped and counted, never fetched. This exists because some documents cannot be
// fetched again at all (Carrefour answers 406 for old tickets, ING keeps about ninety days), so before
// this, changing destination quietly meant losing everything past the retention window.
//
// local-folder is not among the origins here: the service worker has no directory handle. The Settings
// page copies that case itself, since only a page can hold one.
export async function runArchiveCopy(cfg, adapters, sink, { signal, onProgress, originId } = {}) {
  const per = [];
  let sent = 0, found = 0, skipped = 0;
  for (const ds of (cfg.datasources || [])) {
    if (signal && signal.aborted) break;
    if (ds.enabled === false) continue;
    const adapter = adapters[ds.adapter];
    if (!adapter) continue;
    const name = adapter.name || ds.adapter;
    let picked = [];
    try { picked = await pickStoredDocs(ds, adapter, sink); } catch (e) { picked = []; }
    if (!picked.length) { per.push({ datasource: ds.id, name, found: 0, sent: 0 }); continue; }
    found += picked.length;
    if (onProgress) onProgress({ phase: 'source', name, found: picked.length });
    let r;
    try {
      r = await sendStoredDocs(ds, adapter, sink, picked, { noOpen: true, noSource: true, signal, originId });
    } catch (e) {
      per.push({ datasource: ds.id, name, found: picked.length, sent: 0, error: (e && e.message) || String(e) });
      continue;
    }
    sent += r.sent || 0;
    // "Accepted" counts what the destination's `accepts` filter let through; anything found but not sent
    // had no file in any readable destination, which is worth reporting rather than hiding.
    skipped += Math.max(0, (r.accepted || 0) - (r.sent || 0));
    per.push({ datasource: ds.id, name, found: picked.length, sent: r.sent || 0, accepted: r.accepted || 0 });
    if (onProgress) onProgress({ phase: 'done-source', name, sent: r.sent || 0 });
  }
  await appendLog({ kind: 'archive-copy', sink: sink.id, status: 'ok', count: sent });
  // Failures per source were recorded and never shown, so a copy that could not write a single file
  // looked exactly like a copy with nothing to do. Surface the count and the first message.
  const failed = per.filter((x) => x.error);
  return { status: signal && signal.aborted ? 'stopped' : 'done', sent, found, skipped, per,
    failed: failed.length, firstError: failed.length ? failed[0].error : '' };
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

function notify(message, kind) {
  // `kind` tags an actionable notification whose click opens Settings (e.g. 'noperm' → re-grant site access).
  const id = kind ? 'habeas-' + kind + ':' + Date.now() : undefined;
  try { chrome.notifications.create(id, { type: 'basic', iconUrl: 'icon-128.png', title: 'Habeas', message }); }
  catch (e) {}
}
// A tagged notification (e.g. site-access revoked) is a call to action — open Settings, where a single click
// re-requests the permission (the user gesture the background lacks).
try {
  chrome.notifications.onClicked.addListener((id) => {
    if (typeof id === 'string' && id.startsWith('habeas-')) { try { chrome.runtime.openOptionsPage(); } catch (e) {} try { chrome.notifications.clear(id); } catch (e) {} }
  });
} catch (e) {}

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
