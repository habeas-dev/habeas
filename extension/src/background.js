// Background service worker. Stores captured session auth (never on disk) and, on the
// user's own login, runs any `mode: auto` route: list -> only NEW (per ledger) -> send to
// a SW-runnable sink (drive/http) -> mark -> notify. This is triggered by the user's own
// login, not a background job while they're away.
import { chrome } from './lib/ext.js';
import { getConfig } from './lib/config.js';
import { deliveredSet, markDelivered, appendLog } from './lib/state.js';
import { listInventory, fetchDocument, documentExt } from './runtime/inventory.js';
import { resolveSiteFetch } from './lib/pagefetch.js';
import { writeToSink } from './sinks/sinks.js';
import { acceptsDoc } from './sinks/format.js';
import { getAdapters } from './adapters/index.js';
import { hasConsent } from './lib/consent.js';
import { badgeWorking, badgeCount, badgeError, badgeClear } from './lib/badge.js';
import { t } from './lib/i18n.js';
import { validateProposal, originHost } from './lib/exthooks.js';
import { getGrant, grantsForOrigin, grantUsableBy, touchGrant } from './lib/grants.js';

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/popup.html') });
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
  if (msg.type === 'habeas:auth' && msg.host) {
    const key = 'auth:' + msg.host;
    chrome.storage.session.get(key).then((o) => {
      const cur = o[key] || { merged: {}, byPath: {} };
      cur.merged = { ...cur.merged, ...msg.headers };
      if (msg.path) cur.byPath[msg.path] = { ...(cur.byPath[msg.path] || {}), ...msg.headers };
      chrome.storage.session.set({ [key]: cur }).then(() => { maybeAutoRun(msg.host); runPendingExternalCollects(msg.host); });
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
  }
});

const DEBOUNCE_MS = 10 * 60 * 1000;
const running = new Set();

async function maybeAutoRun(host) {
  const cfg = await getConfig();
  const adapters = await getAdapters();
  for (const route of (cfg.routes || []).filter((r) => r.mode === 'auto')) {
    if (running.has(route.id)) continue;
    const ds = cfg.datasources.find((d) => d.id === route.datasource && d.enabled);
    const adapter = ds && adapters[ds.adapter];
    if (!adapter || hostOf(adapter) !== host) continue;
    if (!(await hasConsent(adapter))) continue; // community/cross-domain source not yet consented
    const sink = cfg.sinks.find((s) => s.id === route.sink);
    if (!sink || sink.type === 'download' || sink.type === 'local-folder') continue; // need a page
    const dk = 'autoLast:' + route.id;
    const o = await chrome.storage.session.get(dk);
    if (o[dk] && Date.now() - o[dk] < DEBOUNCE_MS) continue;
    running.add(route.id);
    await chrome.storage.session.set({ [dk]: Date.now() });
    runRoute(ds, adapter, sink).finally(() => running.delete(route.id));
  }
}

const hostOf = (adapter) => adapter.api.host.replace(/^https?:\/\//, '');

async function authFor(adapter) {
  const cookie = adapter.auth && adapter.auth.mode === 'cookie';
  const o = await chrome.storage.session.get('auth:' + hostOf(adapter));
  const store = o['auth:' + hostOf(adapter)];
  // Whole store → each endpoint resolves its own auth (mixed cookie+bearer). Cookie sources proceed
  // with an empty store (cookies carry the session).
  if (!store) return cookie ? { byPath: {}, merged: {} } : null;
  return { byPath: store.byPath || {}, merged: store.merged || {} };
}

async function runRoute(ds, adapter, sink, opts = {}) {
  const kind = opts.kind || 'auto';
  const base = { kind, datasource: ds.id, sink: sink.id, ...(opts.origin ? { origin: opts.origin } : {}) };
  await badgeWorking();
  try {
    const auth = await authFor(adapter);
    if (!auth) { await appendLog({ ...base, status: 'nosession' }); await badgeClear(); return { status: 'nosession' }; }
    const net = opts.net || await resolveSiteFetch(adapter); // fetch from the user's tab → inherits the session
    const all = await listInventory(adapter, auth, net);
    const delivered = await deliveredSet(ds.id, sink.id);
    const fresh = all.filter((d) => !delivered[d.internalId]);
    const eligible = fresh.filter((d) => acceptsDoc(sink, d));
    if (!eligible.length) { await appendLog({ ...base, status: 'none', new: 0 }); await badgeClear(); return { status: 'done', new: 0 }; }
    const files = new Map();
    for (const d of eligible) { try { files.set(d.internalId, (await fetchDocument(adapter, auth, d, net)).blob); } catch (e) { /* no document */ } }
    await writeToSink(sink, eligible, files, { service: adapter.service || ds.adapter, source: adapter.id, ext: documentExt(adapter) || 'pdf', interactive: !!opts.interactive });
    await markDelivered(ds.id, sink.id, eligible.map((d) => d.internalId));
    await appendLog({ ...base, status: 'ok', new: eligible.length });
    if (kind === 'auto') notify(t('notify_new', [String(eligible.length), sink.id])); // external collect: the tab + activity log are the surface (no extra notification)
    await badgeCount(eligible.length);
    return { status: 'done', new: eligible.length };
  } catch (e) {
    await appendLog({ ...base, status: 'error', error: (e && e.message) || String(e) });
    if (kind === 'auto') notify(t('notify_autoerr', [(e && e.message) || String(e)]));
    await badgeError();
    return { status: 'error', error: (e && e.message) || String(e) };
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
  if (api === 'status') return extStatus(origin);
  return { ok: false, status: 'error', error: 'unknown api' };
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

  if (live) { runExternalCollect(grant, ds, adapter, sink, tab && tab.id); return { ok: true, status: 'collecting' }; }
  await addPending(host, { grantId: grant.id, tabId: tab && tab.id, origin });
  await appendLog({ kind: 'ext-collect', origin, source: ds.id, status: 'needs-login' });
  return { ok: true, status: 'needs-login' };
}

async function hasLiveSession(adapter) {
  const cookie = adapter.auth && adapter.auth.mode === 'cookie';
  const o = await chrome.storage.session.get('auth:' + hostOf(adapter));
  const store = o['auth:' + hostOf(adapter)];
  if (cookie) return !!store;
  return !!(store && store.merged && Object.keys(store.merged).length);
}

function injectCapture(tabId) {
  if (!tabId || !chrome.scripting) return;
  try { chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/bridge.js'] }).catch(() => {}); } catch (e) {}
}

async function runExternalCollect(grant, ds, adapter, sink, tabId) {
  const net = tabId ? await resolveSiteFetch(adapter).catch(() => null) : null;
  return runRoute(ds, adapter, sink, { kind: 'ext', origin: grant.origin, interactive: true, net: net || undefined });
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
    if (adapter && sink) runExternalCollect(grant, ds, adapter, sink, entry.tabId);
  }
}

function notify(message) {
  try { chrome.notifications.create({ type: 'basic', iconUrl: 'icon-128.png', title: 'Habeas', message }); }
  catch (e) {}
}
