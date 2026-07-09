// Canonical store — public API. Extraction/delivery write records here (write-through); sinks and
// consumers are PROJECTIONS of it (docs/canonical-store.md). Backend-pluggable: defaults to the local
// IndexedDB host; a later phase lets the user host it on a folder/Drive/HTTP backend and MOVE it between
// them. All record shaping lives in the pure format module; this layer just stamps time + does I/O.
import * as local from './store/local.js';
import { emptySource, mergeItems, mergeSources, project, views } from './store/format.js';

let backend = local; // canonical backend; Phase 3 resolves this from config + adds a per-instance cache
export function setBackend(b) { backend = b || local; }
const now = () => new Date().toISOString();

// Write-through: merge captured items into a source's store. entries: [{ internalId, record,
// docAvailable? }] (or tombstones { internalId, gone, goneReason }). Each is stamped `at` now unless given.
export async function putItems(sourceId, entries, meta) {
  if (!entries || !entries.length) return;
  const stamped = entries.map((e) => ({ ...e, at: e.at || now(), ...(e.gone ? { goneAt: e.goneAt || now() } : {}) }));
  const cur = (await backend.loadSource(sourceId)) || emptySource(meta);
  await backend.saveSource(sourceId, mergeItems(cur, stamped, meta));
}

// Record delivered docs into the store from a send: pass the docs (each with .record) that were sent.
export async function recordDelivered(sourceId, docs, meta) {
  await putItems(sourceId, (docs || []).filter((d) => d && d.internalId != null).map((d) => ({
    internalId: d.internalId,
    record: d.record || d,
    docAvailable: d.docAvailable,
  })), meta);
}

export async function markGone(sourceId, ids, reason) {
  await putItems(sourceId, (ids || []).map((id) => ({ internalId: id, gone: true, goneReason: reason || 'rescan' })));
}

export async function getSource(sourceId) { return (await backend.loadSource(sourceId)) || null; }
export async function getRecords(sourceId, opts) { return project(await backend.loadSource(sourceId), opts); }
export async function getViews(sourceId, delivered) { return views(await backend.loadSource(sourceId), delivered); }
export async function countLive(sourceId) { const s = await backend.loadSource(sourceId); return s ? Object.values(s.items).filter((e) => !e.gone).length : 0; }

// Move/rehydrate: union this source's data from another backend into the current one (never clobbers).
export async function mergeFrom(sourceId, otherBackend) {
  const from = await otherBackend.loadSource(sourceId); if (!from) return;
  const cur = (await backend.loadSource(sourceId)) || emptySource(from.meta);
  await backend.saveSource(sourceId, mergeSources(cur, from));
}
