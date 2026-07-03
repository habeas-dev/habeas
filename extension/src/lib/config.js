// Config store: datasources / sinks / routes as a versioned JSON in storage.local.
// Local-first: nothing here leaves the browser. Secrets live elsewhere (secrets.js).
const KEY = 'habeas:config';
const DEFAULT = { version: 1, datasources: [], sinks: [], routes: [] };

export async function getConfig() {
  const o = await chrome.storage.local.get(KEY);
  return o[KEY] || structuredClone(DEFAULT);
}
export async function saveConfig(cfg) {
  await chrome.storage.local.set({ [KEY]: cfg });
}
export async function upsert(kind, item) {
  const cfg = await getConfig();
  const arr = cfg[kind];
  const i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) arr[i] = item; else arr.push(item);
  await saveConfig(cfg);
  return cfg;
}
export async function remove(kind, id) {
  const cfg = await getConfig();
  cfg[kind] = cfg[kind].filter((x) => x.id !== id);
  await saveConfig(cfg);
  return cfg;
}
