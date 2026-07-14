// Background service worker. Stores captured session auth (never on disk) and, on the
// user's own login, runs any `mode: auto` route: list -> only NEW (per ledger) -> send to
// a SW-runnable sink (drive/http) -> mark -> notify. This is triggered by the user's own
// login, not a background job while they're away.
import { chrome } from './lib/ext.js';
import { getConfig } from './lib/config.js';
import { registerCapture } from './lib/capture.js';
import { loadAuth, hasAuth } from './lib/authstore.js';
import { deliveredSet, markDelivered, appendLog, rememberDocMeta } from './lib/state.js';
import { listInventory, listGroups, artifactKinds, fetchArtifact, documentExt } from './runtime/inventory.js';
import { resolveSiteFetch, ensureSiteFetch, recoverSession } from './lib/pagefetch.js';
import { renderPage, isChallenged, challengeUrlOf } from './lib/render.js';
import { writeToSink } from './sinks/sinks.js';
import { recordDelivered } from './lib/store.js';
import { acceptsDoc, sinkAcceptsArtifact, sinkAcceptsSource, bakeLearned } from './sinks/format.js';
import { outputsForSink, resolveOutput, storeKeyOf } from './lib/outputs.js';
import { getAdapters } from './adapters/index.js';
import { hasConsent } from './lib/consent.js';
import { badgeWorking, badgeCount, badgeError, badgeClear, setStatus } from './lib/badge.js';
import { t } from './lib/i18n.js';
import { validateProposal, originHost } from './lib/exthooks.js';
import { getGrant, grantsForOrigin, grantUsableBy, touchGrant } from './lib/grants.js';
import { migrateSinkHeaders } from './lib/sinkheaders.js';
import { autoDebounced, retainAutoDebounce, isLoginNavigation, needsTabEscalation, sweepSinkId } from './lib/autosync.js';

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/popup.html') });
});

// On startup, (re)register the in-session capture bridge for every enabled source (dynamic content
// scripts can be dropped on an extension update). Idempotent; needs the host permission already granted.
(async () => {
  try {
    const cfg = await getConfig();
    const adapters = await getAdapters();
    for (const d of (cfg.datasources || []).filter((x) => x.enabled)) { const a = adapters[d.adapter]; if (a) await registerCapture(a); }
  } catch (e) {}
  // One-time: encrypt any pairing-token headers left plaintext in config by older versions.
  migrateSinkHeaders().catch(() => {});
  syncWebRequestCapture();
})();
// Re-sync the webRequest capture filter when the enabled sources change.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && (ch['habeas:config'] || ch['habeas:sources'])) syncWebRequestCapture();
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
function onWebRequestHeaders(details) {
  try {
    const u = new URL(details.url);
    const adapters = WR_MAP[u.host];
    if (!adapters || !adapters.length) return;
    const reqH = details.requestHeaders || [];
    const authz = reqH.find((h) => h.name.toLowerCase() === 'authorization');
    for (const a of adapters) {
      if (authz && authz.value) {
        const tm = (a.auth && a.auth.tokenMatch) || 'eyJ';
        let ok; try { ok = new RegExp(tm).test(authz.value); } catch (e) { ok = authz.value.indexOf(tm) >= 0; }
        if (ok) {
          // Capture EVERY header this source replays (not just the token) — a source may need a companion
          // header alongside the bearer (e.g. ING's x-ing-extendedsessioncontext). Default: authorization only.
          const want = new Set(((a.auth && a.auth.replayHeaders) || ['authorization']).map((h) => h.toLowerCase()));
          const hdrs = { authorization: authz.value };
          for (const h of reqH) { const ln = h.name.toLowerCase(); if (want.has(ln) && h.value) hdrs[ln] = h.value; }
          saveAuth(u.host, u.pathname, hdrs).then(() => { maybeAutoRun(u.host); runPendingExternalCollects(u.host); });
        }
      }
      for (const c of (a.auth && a.auth.context) || []) {
        let m; try { m = new RegExp(c.match).exec(details.url); } catch (e) { continue; }
        if (m && m[1]) saveContext(u.host, c.name, m[1]);
      }
    }
  } catch (e) {}
}
async function syncWebRequestCapture() {
  if (!(chrome.webRequest && chrome.webRequest.onSendHeaders)) return;
  const cfg = await getConfig();
  const adapters = await getAdapters();
  const map = {};
  const add = (h, a) => { const host = bareHost(h); if (host) (map[host] = map[host] || []).push(a); };
  for (const d of (cfg.datasources || []).filter((x) => x.enabled)) {
    const a = adapters[d.adapter];
    if (!a || !(a.auth && a.auth.mode === 'bearer')) continue; // cookie sources carry the session in cookies
    if (a.api && a.api.host) add(a.api.host, a);
    for (const ch of a.crossDomainHosts || []) add(ch, a);
    for (const m of a.match || []) add(m, a);
  }
  WR_MAP = map;
  try { chrome.webRequest.onSendHeaders.removeListener(onWebRequestHeaders); } catch (e) {}
  const urls = Object.keys(map).map((h) => `*://${h}/*`);
  if (!urls.length) return;
  try { chrome.webRequest.onSendHeaders.addListener(onWebRequestHeaders, { urls }, ['requestHeaders', 'extraHeaders']); }
  catch (e) { try { chrome.webRequest.onSendHeaders.addListener(onWebRequestHeaders, { urls }, ['requestHeaders']); } catch (e2) {} }
}

// Auto-sync trigger for cookie sources (and any source): when the user lands on the source's own
// site (tab finished loading in their session), try the auto routes. `tab.url` is only visible for
// hosts we have permission for — i.e. exactly the enabled/consented sources. Debounced in runAutoRoutes.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' || !tab || !tab.url || !/^https:\/\//.test(tab.url)) return;
  let host; try { host = new URL(tab.url).host; } catch (e) { return; }
  maybeAutoRunForSite(host, tabId, tab.url).catch(() => {});
});

const SAMPLE_CAP = 60;

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
  if (msg.type === 'habeas:auth' && msg.host) {
    saveAuth(msg.host, msg.path, msg.headers).then(() => { maybeAutoRun(msg.host); runPendingExternalCollects(msg.host); });
  } else if (msg.type === 'habeas:context' && msg.host && msg.name) {
    // A captured CONTEXT value (e.g. a DNI seen in a request URL), stored alongside auth in
    // storage.session (never on disk) and later templated as {ctx.<name>} by the runtime.
    saveContext(msg.host, msg.name, msg.value);
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
// Trigger A: captured auth (a bearer source's JWT was seen). host = the API host.
const maybeAutoRun = (host) => runAutoRoutes((a) => hostOf(a) === host);
// Trigger B: the user navigated to the source's site — works for cookie sources too (no JWT to capture).
const maybeAutoRunForSite = (host, tabId, url) => runAutoRoutes((a) => siteMatches(a, host), tabId, url);

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
    const net = opts.net || await resolveSiteFetch(adapter); // fetch from the user's tab → inherits the session
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
      const fresh = all.filter((d) => !delivered[d.internalId]);
      // Deliver oldest → newest (the list comes newest-first) — files written + manifest appended + store
      // recorded chronologically, matching the manual send. Covers auto, sweep and external collect.
      const eligible = fresh.filter((d) => acceptsDoc(sink, d))
        .sort((a, b) => ((a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0));
      if (!eligible.length) continue;
      setStatus(t('status_fetching', [String(eligible.length), name]));
      const files = new Map();
      for (const d of eligible) {
        if (opts.signal && opts.signal.aborted) break; // stop fetching mid-source
        const arts = [];
        for (const fmt of (fmts.length ? fmts : [''])) {
          const oeff = resolveOutput(adapter, sid + (fmt ? '/' + fmt : ''));
          const kinds = artifactKinds(oeff).filter((k) => sinkAcceptsArtifact(sink, k));
          const avail = artifactKinds(oeff, d); // per-doc: drops the document (e.g. invoice PDF) if this doc lacks it
          for (const k of kinds) {
            if (!avail.some((a) => a.kind === k.kind)) continue; // this ticket has no such artifact (no invoice) → skip cleanly
            try { arts.push(await fetchArtifact(oeff, auth, d, net, renderPage, k.kind)); } catch (e) { /* artifact unavailable */ }
          }
        }
        if (arts.length) files.set(d.internalId, arts);
      }
      setStatus(t('status_sending', [String(eligible.length), sink.id]));
      await writeToSink(sink, eligible, files, { service: adapter.service || ds.adapter, source: sk, ext: documentExt(eff) || 'pdf', interactive: !!opts.interactive });
      await markDelivered(ds.id, sink.id, eligible.map((d) => d.internalId));
      for (const d of eligible) d.record = bakeLearned(d); // persist the real date/amount learned from the detail
      try { await recordDelivered(sk, eligible, { source: adapter.id, schema: eff.schema }); } catch (e) { /* store is best-effort */ } // write-through to the canonical store
      try { await rememberDocMeta(adapter.id, eligible.map((d) => ({ internalId: d.internalId, date: /^\d{4}-\d{2}-\d{2}/.test(d.date || '') ? d.date : undefined, total: typeof d.total === 'number' ? d.total : undefined, returnStatus: d.returnStatus || undefined }))); } catch (e) { /* best-effort */ }
      totalNew += eligible.length;
    }
    if (!totalNew) { await appendLog({ ...base, status: 'none', new: 0 }); await badgeClear(); setStatus(t('status_none', [name])); return { status: 'done', new: 0 }; }

    await appendLog({ ...base, status: 'ok', new: totalNew });
    if (kind === 'auto') notify(t('notify_new', [String(totalNew), sink.id])); // external collect: the tab + activity log are the surface (no extra notification)
    await badgeCount(totalNew);
    setStatus(t('status_done', [String(totalNew), name]));
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
  if (api === 'status') return extStatus(origin);
  return { ok: false, status: 'error', error: 'unknown api' };
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
