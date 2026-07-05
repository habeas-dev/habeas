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
