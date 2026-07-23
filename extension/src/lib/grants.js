// External-hooks grant store. A grant links ONE web origin to ONE approved route (datasource →
// sink), authorizing that origin to later trigger collection for it (capability B) without
// re-consent — but never to widen scope. Lives in storage.local under `habeas:grants`.
//
//   { id, origin, datasourceId, sinkId, filter, createdAt, lastUsedAt }
import { chrome } from './ext.js';

const KEY = 'habeas:grants';

export async function getGrants() {
  const o = await chrome.storage.local.get(KEY);
  return o[KEY] || [];
}
async function setGrants(list) { await chrome.storage.local.set({ [KEY]: list }); }

export async function grantsForOrigin(origin) {
  return (await getGrants()).filter((g) => g.origin === origin);
}
export async function getGrant(id) {
  return (await getGrants()).find((g) => g.id === id) || null;
}
export async function addGrant(grant) {
  // One grant per (origin, route/kind): re-approving REPLACES the previous grant instead of
  // stacking duplicates (a consumer that re-proposes the same source got one grant per approval).
  const same = (g) => g.origin === grant.origin &&
    (grant.kind ? g.kind === grant.kind : !g.kind && g.datasourceId === grant.datasourceId);
  const list = (await getGrants()).filter((g) => !same(g));
  list.push(grant);
  await setGrants(list);
  return grant;
}
export async function revokeGrant(id) {
  await setGrants((await getGrants()).filter((g) => g.id !== id));
}
export async function touchGrant(id, when) {
  const list = await getGrants();
  const g = list.find((x) => x.id === id);
  if (g) { g.lastUsedAt = when; await setGrants(list); }
}

// A grant is usable by a caller only if it exists AND belongs to the caller's origin.
export function grantUsableBy(grant, origin) {
  return !!(grant && grant.origin && origin && grant.origin === origin);
}
