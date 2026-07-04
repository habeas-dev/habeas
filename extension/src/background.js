// Background service worker. Stores captured session auth (never on disk) and, on the
// user's own login, runs any `mode: auto` route: list -> only NEW (per ledger) -> send to
// a SW-runnable sink (drive/http) -> mark -> notify. This is triggered by the user's own
// login, not a background job while they're away.
import { getConfig } from './lib/config.js';
import { deliveredSet, markDelivered } from './lib/state.js';
import { listInventory, fetchPdf } from './runtime/inventory.js';
import { writeToSink } from './sinks/sinks.js';
import { ADAPTERS } from './adapters/index.js';

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/popup.html') });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'habeas:auth' || !msg.host) return;
  const key = 'auth:' + msg.host;
  chrome.storage.session.get(key).then((o) => {
    const cur = o[key] || { merged: {}, byPath: {} };
    cur.merged = { ...cur.merged, ...msg.headers };
    if (msg.path) cur.byPath[msg.path] = { ...(cur.byPath[msg.path] || {}), ...msg.headers };
    chrome.storage.session.set({ [key]: cur }).then(() => maybeAutoRun(msg.host));
  });
});

const DEBOUNCE_MS = 10 * 60 * 1000;
const running = new Set();

async function maybeAutoRun(host) {
  const cfg = await getConfig();
  for (const route of (cfg.routes || []).filter((r) => r.mode === 'auto')) {
    if (running.has(route.id)) continue;
    const ds = cfg.datasources.find((d) => d.id === route.datasource && d.enabled);
    const adapter = ds && ADAPTERS[ds.adapter];
    if (!adapter || hostOf(adapter) !== host) continue;
    const sink = cfg.sinks.find((s) => s.id === route.sink);
    if (!sink || sink.type === 'download' || sink.type === 'local-folder') continue; // need a page
    const dk = 'autoLast:' + route.id;
    const o = await chrome.storage.session.get(dk);
    if (o[dk] && Date.now() - o[dk] < DEBOUNCE_MS) continue;
    running.add(route.id);
    await chrome.storage.session.set({ [dk]: Date.now() });
    runRoute(ds, adapter, sink)
      .catch((e) => notify('Auto-sync error: ' + (e && e.message ? e.message : e)))
      .finally(() => running.delete(route.id));
  }
}

const hostOf = (adapter) => adapter.api.host.replace(/^https?:\/\//, '');

async function authFor(adapter) {
  const o = await chrome.storage.session.get('auth:' + hostOf(adapter));
  const store = o['auth:' + hostOf(adapter)];
  if (!store) return null;
  return store.byPath[adapter.api.list.path] || store.merged || null;
}

async function runRoute(ds, adapter, sink) {
  const auth = await authFor(adapter);
  if (!auth) return;
  const all = await listInventory(adapter, auth);
  const delivered = await deliveredSet(ds.id, sink.id);
  const fresh = all.filter((d) => !delivered[d.externalId]);
  if (!fresh.length) return;
  const files = new Map();
  for (const d of fresh) { try { files.set(d.externalId, await fetchPdf(adapter, auth, d.externalId)); } catch (e) { /* no PDF */ } }
  await writeToSink(sink, fresh, files, { service: adapter.service || ds.adapter, interactive: false });
  await markDelivered(ds.id, sink.id, fresh.map((d) => d.externalId));
  notify(`${fresh.length} documento(s) nuevo(s) → ${sink.id}`);
}

function notify(message) {
  try { chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title: 'Habeas', message }); }
  catch (e) {}
}
