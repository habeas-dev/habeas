// Background service worker. Stores captured session auth (never on disk) and, on the
// user's own login, runs any `mode: auto` route: list -> only NEW (per ledger) -> send to
// a SW-runnable sink (drive/http) -> mark -> notify. This is triggered by the user's own
// login, not a background job while they're away.
import { chrome } from './lib/ext.js';
import { getConfig } from './lib/config.js';
import { deliveredSet, markDelivered, appendLog } from './lib/state.js';
import { listInventory, fetchDocument, documentExt } from './runtime/inventory.js';
import { writeToSink } from './sinks/sinks.js';
import { acceptsDoc } from './sinks/format.js';
import { getAdapters } from './adapters/index.js';
import { hasConsent } from './lib/consent.js';
import { badgeWorking, badgeCount, badgeError, badgeClear } from './lib/badge.js';
import { t } from './lib/i18n.js';

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/popup.html') });
});

const SAMPLE_CAP = 60;

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'habeas:auth' && msg.host) {
    const key = 'auth:' + msg.host;
    chrome.storage.session.get(key).then((o) => {
      const cur = o[key] || { merged: {}, byPath: {} };
      cur.merged = { ...cur.merged, ...msg.headers };
      if (msg.path) cur.byPath[msg.path] = { ...(cur.byPath[msg.path] || {}), ...msg.headers };
      chrome.storage.session.set({ [key]: cur }).then(() => maybeAutoRun(msg.host));
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

async function runRoute(ds, adapter, sink) {
  const base = { kind: 'auto', datasource: ds.id, sink: sink.id };
  await badgeWorking();
  try {
    const auth = await authFor(adapter);
    if (!auth) { await appendLog({ ...base, status: 'nosession' }); await badgeClear(); return; }
    const all = await listInventory(adapter, auth);
    const delivered = await deliveredSet(ds.id, sink.id);
    const fresh = all.filter((d) => !delivered[d.externalId]);
    const eligible = fresh.filter((d) => acceptsDoc(sink, d));
    if (!eligible.length) { await appendLog({ ...base, status: 'none', new: 0 }); await badgeClear(); return; }
    const files = new Map();
    for (const d of eligible) { try { files.set(d.externalId, (await fetchDocument(adapter, auth, d.externalId)).blob); } catch (e) { /* no document */ } }
    await writeToSink(sink, eligible, files, { service: adapter.service || ds.adapter, ext: documentExt(adapter) || 'pdf', interactive: false });
    await markDelivered(ds.id, sink.id, eligible.map((d) => d.externalId));
    await appendLog({ ...base, status: 'ok', new: eligible.length });
    notify(t('notify_new', [String(eligible.length), sink.id]));
    await badgeCount(eligible.length);
  } catch (e) {
    await appendLog({ ...base, status: 'error', error: (e && e.message) || String(e) });
    notify(t('notify_autoerr', [(e && e.message) || String(e)]));
    await badgeError();
  }
}

function notify(message) {
  try { chrome.notifications.create({ type: 'basic', iconUrl: 'icon-128.png', title: 'Habeas', message }); }
  catch (e) {}
}
