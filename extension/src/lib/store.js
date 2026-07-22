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
// The active configured backend (respects a test-injected override). Used by the store migration to walk and
// rewrite the store in place wherever it lives.
export async function activeBackend() { return backendFor(); }
// Open an ARBITRARY backend without repointing the global config — used by the store browser to inspect
// (and repair) any backend directly (the configured one, plain local, or a specific cloud sink's store).
export async function openBackend(cfg) { return makeBackend(cfg); }
const now = () => new Date().toISOString();

// Write-through: merge captured items into a source's store. entries: [{ internalId, record, docAvailable? }]
// (or tombstones { internalId, gone, goneReason }). Each is stamped `at` now unless given.
export async function putItems(sourceId, entries, meta) {
  if (!entries || !entries.length) return;
  // Stamp each entry with the source version that produced it (from meta.srcVersion) so the store records what
  // normalization each item was last built with — used by migrations to decide what needs reprocessing.
  const sv = meta && meta.srcVersion;
  const stamped = entries.map((e) => ({ ...e, at: e.at || now(), ...(e.gone ? { goneAt: e.goneAt || now() } : {}), ...(e.srcVersion || sv ? { srcVersion: e.srcVersion || sv } : {}) }));
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

export async function listSources() { try { return await (await backendFor()).listSources(); } catch (e) { return []; } }
// Public read helpers stay tolerant (a flaky/unconnected cloud backend must not crash the popup's normal
// list flow) — they degrade to null/empty. The store BROWSER calls a backend's loadSource DIRECTLY so it
// can surface the real failure reason (see ui/store-browser.js).
export async function getSource(sourceId) { try { return (await (await backendFor()).loadSource(sourceId)) || null; } catch (e) { return null; } }

// Delete specific items from a source's store (debug/repair). Returns how many were removed.
export async function deleteStoreItems(sourceId, ids) {
  const backend = await backendFor();
  const src = await backend.loadSource(sourceId);
  if (!src || !src.items) return 0;
  let n = 0;
  for (const id of ids || []) { if (src.items[String(id)]) { delete src.items[String(id)]; n++; } }
  if (n) await backend.saveSource(sourceId, src);
  return n;
}
// Empty a source's store entirely (keeps its meta). A full backend "delete file/entry" isn't part of the
// backend interface, so the source stays listed but empty.
export async function clearStoreSource(sourceId) {
  const backend = await backendFor();
  const src = await backend.loadSource(sourceId);
  await backend.saveSource(sourceId, { meta: (src && src.meta) || {}, items: {} });
}
// Fully remove a source's store entry so it stops being listed (the local backend deletes the key; cloud
// backends that don't implement a delete are emptied as a fallback). Used to auto-clean orphan keys left behind
// by a removed/renamed source (e.g. raisin-es → raisin).
export async function deleteSource(sourceId) {
  const backend = await backendFor();
  if (typeof backend.clearSource === 'function') { try { return await backend.clearSource(sourceId); } catch (e) { /* fall through to empty */ } }
  try { await backend.saveSource(sourceId, { meta: {}, items: {} }); } catch (e) {}
}
export async function getRecords(sourceId, opts) { try { return project(await (await backendFor()).loadSource(sourceId), opts); } catch (e) { return project(null, opts); } }
export async function getViews(sourceId, delivered) { try { return views(await (await backendFor()).loadSource(sourceId), delivered); } catch (e) { return views(null, delivered); } }
// Passive UI hint (the "Load from store" button badge) → never pop an OAuth window just to count; a Drive
// backend reads this silently (interactive:false) and returns null if no token is available yet.
export async function countLive(sourceId) { try { const s = await (await backendFor()).loadSource(sourceId, { interactive: false }); return s ? Object.values(s.items).filter((e) => !e.gone).length : 0; } catch (e) { return 0; } }

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
