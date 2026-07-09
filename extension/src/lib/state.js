import { chrome } from './ext.js';
// Delivery ledger — tracks which documents have already been sent to each sink, so we
// don't re-deliver them. Keyed by "<datasourceId>::<sinkId>" -> { internalId: isoTime }.
// This is runtime state (storage.local), separate from config and secrets.
const KEY = 'habeas:state';

async function getState() {
  const o = await chrome.storage.local.get(KEY);
  return o[KEY] || { delivered: {} };
}
function keyFor(datasourceId, sinkId) { return datasourceId + '::' + sinkId; }

export async function deliveredSet(datasourceId, sinkId) {
  const st = await getState();
  return st.delivered[keyFor(datasourceId, sinkId)] || {};
}

export async function markDelivered(datasourceId, sinkId, internalIds) {
  const st = await getState();
  const k = keyFor(datasourceId, sinkId);
  const set = st.delivered[k] || {};
  const now = new Date().toISOString();
  for (const id of internalIds) set[id] = now;
  st.delivered[k] = set;
  await chrome.storage.local.set({ [KEY]: st });
}

export async function forgetDelivered(datasourceId, sinkId) {
  const st = await getState();
  delete st.delivered[keyFor(datasourceId, sinkId)];
  await chrome.storage.local.set({ [KEY]: st });
}

// Learned per-document metadata (SOURCE level, not per sink): facts we discovered by fetching a
// document's detail — its real date + amount. Lets a later listing show the true date for items whose
// list only exposes a year (Amazon). A minimal precursor to the incremental-sync index (docs/incremental-sync.md).
const META_KEY = 'habeas:docmeta';
export async function getDocMeta(sourceId) {
  const o = await chrome.storage.local.get(META_KEY);
  return (o[META_KEY] || {})[sourceId] || {};
}
export async function rememberDocMeta(sourceId, entries) { // entries: [{ internalId, date }]
  if (!entries || !entries.length) return;
  const o = await chrome.storage.local.get(META_KEY);
  const all = o[META_KEY] || {};
  const m = all[sourceId] || {};
  for (const e of entries) if (e && e.internalId != null) m[e.internalId] = { ...(m[e.internalId] || {}), ...(e.date ? { date: e.date } : {}), ...(typeof e.total === 'number' ? { total: e.total } : {}), ...(e.returnStatus ? { returnStatus: e.returnStatus } : {}) };
  all[sourceId] = m;
  await chrome.storage.local.set({ [META_KEY]: all });
}

// Activity log — a rolling record of runs (auto + manual) so the user can see whether a
// sync happened without opening Drive. Kept in storage.local (last 100 entries).
const LOG_KEY = 'habeas:log';
export async function appendLog(entry) {
  const o = await chrome.storage.local.get(LOG_KEY);
  const log = o[LOG_KEY] || [];
  log.unshift({ t: new Date().toISOString(), ...entry });
  await chrome.storage.local.set({ [LOG_KEY]: log.slice(0, 100) });
}
export async function getLog() {
  const o = await chrome.storage.local.get(LOG_KEY);
  return o[LOG_KEY] || [];
}
