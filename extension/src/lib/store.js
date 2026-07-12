// Canonical store — public API. Extraction/delivery write records here (write-through); sinks and
// consumers are PROJECTIONS of it (docs/canonical-store.md). Backend-pluggable + MOVABLE: the user chooses
// where the store is hosted (local by default, or a folder / Drive / HTTP backend for multi-device) and can
// move it between backends (a union-merge, never clobbering). Record shaping lives in the pure format module.
import { chrome } from './ext.js';
import * as local from './store/local.js';
import { emptySource, mergeItems, mergeSources, project, views } from './store/format.js';

const CFG_KEY = 'habeas:store';
export async function getStoreConfig() { const o = await chrome.storage.local.get(CFG_KEY); return o[CFG_KEY] || { backend: 'local' }; }
export async function setStoreConfig(cfg) { await chrome.storage.local.set({ [CFG_KEY]: cfg }); }

let override = null;               // tests inject an in-memory backend
export function setBackend(b) { override = b; }

// A backend implements { loadSource(id)->data|null, saveSource(id,data), listSources()->[id] }. local is a
// static module; folder/drive/http are factories bound to their config (dir handle / Drive folder / URL).
async function makeBackend(cfg) {
  cfg = cfg || (await getStoreConfig());
  switch (cfg && cfg.backend) {
    case 'folder': return (await import('./store/folder.js')).make(cfg);
    case 'http': return (await import('./store/http.js')).make(cfg);
    case 'drive': return (await import('./store/drive.js')).make(cfg);
    case 'dropbox': return (await import('./store/dropbox.js')).make(cfg);
    case 'webdav': return (await import('./store/webdav.js')).make(cfg);
    case 's3': return (await import('./store/s3.js')).make(cfg);
    default: return local;
  }
}
async function backendFor() { return override || makeBackend(); }
const now = () => new Date().toISOString();

// Write-through: merge captured items into a source's store. entries: [{ internalId, record, docAvailable? }]
// (or tombstones { internalId, gone, goneReason }). Each is stamped `at` now unless given.
export async function putItems(sourceId, entries, meta) {
  if (!entries || !entries.length) return;
  const stamped = entries.map((e) => ({ ...e, at: e.at || now(), ...(e.gone ? { goneAt: e.goneAt || now() } : {}) }));
  const backend = await backendFor();
  const cur = (await backend.loadSource(sourceId)) || emptySource(meta);
  await backend.saveSource(sourceId, mergeItems(cur, stamped, meta));
}

export async function recordDelivered(sourceId, docs, meta) {
  await putItems(sourceId, (docs || []).filter((d) => d && d.internalId != null).map((d) => ({
    internalId: d.internalId, record: d.record || d, docAvailable: d.docAvailable,
  })), meta);
}

export async function markGone(sourceId, ids, reason) {
  await putItems(sourceId, (ids || []).map((id) => ({ internalId: id, gone: true, goneReason: reason || 'rescan' })));
}

export async function getSource(sourceId) { return (await (await backendFor()).loadSource(sourceId)) || null; }
export async function getRecords(sourceId, opts) { return project(await (await backendFor()).loadSource(sourceId), opts); }
export async function getViews(sourceId, delivered) { return views(await (await backendFor()).loadSource(sourceId), delivered); }
// Passive UI hint (the "Load from store" button badge) → never pop an OAuth window just to count; a Drive
// backend reads this silently (interactive:false) and returns null if no token is available yet.
export async function countLive(sourceId) { const s = await (await backendFor()).loadSource(sourceId, { interactive: false }); return s ? Object.values(s.items).filter((e) => !e.gone).length : 0; }

// Union every source from one backend into another (never clobbers; keyed by id). Idempotent → safe to
// re-run an interrupted move. Returns how many sources were copied.
export async function migrate(from, to) {
  const ids = await from.listSources().catch(() => []);
  for (const id of ids) {
    const data = await from.loadSource(id); if (!data) continue;
    const cur = (await to.loadSource(id)) || emptySource(data.meta);
    await to.saveSource(id, mergeSources(cur, data));
  }
  return ids.length;
}

// Move the canonical store to a new backend: migrate current → target, then repoint the config. The old
// backend keeps its copy (a safe fallback / rehydration source) unless the caller clears it.
export async function moveStoreTo(cfg) {
  const from = await backendFor();
  const to = await makeBackend(cfg);
  const n = await migrate(from, to);
  await setStoreConfig(cfg);
  return n;
}
