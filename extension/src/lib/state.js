// Delivery ledger — tracks which documents have already been sent to each sink, so we
// don't re-deliver them. Keyed by "<datasourceId>::<sinkId>" -> { externalId: isoTime }.
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

export async function markDelivered(datasourceId, sinkId, externalIds) {
  const st = await getState();
  const k = keyFor(datasourceId, sinkId);
  const set = st.delivered[k] || {};
  const now = new Date().toISOString();
  for (const id of externalIds) set[id] = now;
  st.delivered[k] = set;
  await chrome.storage.local.set({ [KEY]: st });
}

export async function forgetDelivered(datasourceId, sinkId) {
  const st = await getState();
  delete st.delivered[keyFor(datasourceId, sinkId)];
  await chrome.storage.local.set({ [KEY]: st });
}
