// Canonical store — generic PERIOD-SHARDED layer for file-like backends (dropbox/folder/webdav/s3). One big
// `<id>.json` per source becomes a folder of monthly shards:
//
//   <id>/_meta.json         { meta, shards:[period…] }
//   <id>/2025-01.json       { items: { [internalId]: entry } }   ← items whose record.date is 2025-01
//   <id>/_undated.json      items with no parseable YYYY-MM date
//
// Why: a source that grows to thousands of items (Amazon) no longer lives in one ever-growing JSON that every
// checkpoint rewrites in full (O(n²) bandwidth). A write touches ONLY the month shards its batch spans; a
// recent-orders sync rewrites one or two tiny files, not the whole history.
//
// Transparent to callers: loadSource() reassembles the shards into the same { meta, items } shape as before,
// so format.js, the Archive and consumers are unchanged. A legacy single `<id>.json` is still read, and is
// split into shards (then deleted) on the first appendItems() — lazy migration, nothing to run by hand.
//
// A backend supplies 4 primitives over store-root-relative paths; all shard/period logic lives here:
//   read(relPath) -> object|null   write(relPath, obj)   remove(relPath)   listChildren(relDir) -> [{name,isDir}]
//   removeDir(relDir)  (optional; used to fully drop a source's folder on delete)
import { emptySource, mergeItems, mergeSources } from './format.js';

const metaPath = (id) => `${id}/_meta.json`;
const shardPath = (id, period) => `${id}/${period}.json`;
const legacyPath = (id) => `${id}.json`;
const UNDATED = '_undated';
// Month bucket for an entry: record.date's YYYY-MM (accepts a bare date or an ISO datetime), else _undated.
function periodOf(entry) {
  const d = (entry && entry.record && entry.record.date) || '';
  return /^\d{4}-\d{2}/.test(d) ? String(d).slice(0, 7) : UNDATED;
}
const isShardFile = (name) => /\.json$/.test(name) && name !== '_meta.json';
const periodFromFile = (name) => name.slice(0, -5); // strip ".json"

export function makeShardedStore(prim) {
  // List a source folder's shard files (["2025-01", …]); [] if the folder doesn't exist.
  async function shardPeriods(id) {
    const kids = await prim.listChildren(id).catch(() => []);
    return kids.filter((k) => !k.isDir && isShardFile(k.name)).map((k) => periodFromFile(k.name));
  }

  // Assemble a source from its legacy single file (if any) ∪ every month shard → { meta, items }.
  async function assemble(id, legacy, periods, meta) {
    let data = emptySource((meta && meta.meta) || (legacy && legacy.meta) || {});
    if (legacy && legacy.items) data = mergeSources(data, legacy);
    for (const p of periods) {
      const s = await prim.read(shardPath(id, p)).catch(() => null);
      if (s && s.items) data = mergeSources(data, { meta: {}, items: s.items });
    }
    return data;
  }

  // Reassemble a source → { meta, items } (or null). A legacy single `<id>.json` is REFORMATTED into month
  // shards right here on load (one-time), so simply opening the Archive migrates it — unless this is a passive
  // read (opts.interactive === false, e.g. a badge count), where we must not write.
  async function loadSource(id, opts) {
    const meta = await prim.read(metaPath(id)).catch(() => null);
    const legacy = await prim.read(legacyPath(id)).catch(() => null);
    const periods = await shardPeriods(id);
    if (!meta && !legacy && !periods.length) return null; // nothing stored for this source
    const data = await assemble(id, legacy, periods, meta);
    if (legacy && legacy.items && (!opts || opts.interactive !== false)) {
      try { await saveSource(id, data); } catch (e) { /* no token/permission for a write → serve the read-only assembly */ }
    }
    return data;
  }

  const liveCount = (items) => Object.values(items || {}).filter((e) => !e.gone).length; // for the fast countLive hint

  // Full write (migrate/move/clear/repair): re-split items into month shards, prune stale shards, drop legacy.
  async function saveSource(id, data) {
    const byPeriod = {};
    for (const [iid, e] of Object.entries((data && data.items) || {})) { const p = periodOf(e); (byPeriod[p] || (byPeriod[p] = {}))[iid] = e; }
    const want = new Set(Object.keys(byPeriod));
    for (const p of await shardPeriods(id)) if (!want.has(p)) await prim.remove(shardPath(id, p)).catch(() => {}); // prune emptied months
    const counts = {};
    for (const p of want) { await prim.write(shardPath(id, p), { items: byPeriod[p] }); counts[p] = liveCount(byPeriod[p]); }
    await prim.write(metaPath(id), { meta: (data && data.meta) || {}, shards: [...want], counts }); // counts → cheap badge hint
    await prim.remove(legacyPath(id)).catch(() => {}); // superseded by the shards
  }

  // Incremental write (the hot path): route entries to their month shards; read-merge-write ONLY those shards.
  async function appendItems(id, entries, meta) {
    if (!entries || !entries.length) return;
    const legacy = await prim.read(legacyPath(id)).catch(() => null);
    if (legacy && legacy.items) { await saveSource(id, mergeItems(legacy, [], meta)); } // one-time split of the legacy file
    const byPeriod = {};
    for (const e of entries) { if (!e || e.internalId == null) continue; const p = periodOf(e); (byPeriod[p] || (byPeriod[p] = [])).push(e); }
    const metaFile = (await prim.read(metaPath(id)).catch(() => null)) || { meta: {}, shards: [], counts: {} };
    const shards = new Set(metaFile.shards || []);
    const counts = { ...(metaFile.counts || {}) };
    for (const [p, es] of Object.entries(byPeriod)) {
      const cur = (await prim.read(shardPath(id, p)).catch(() => null)) || { items: {} };
      const merged = mergeItems({ meta: {}, items: cur.items || {} }, es, null);
      await prim.write(shardPath(id, p), { items: merged.items });
      shards.add(p); counts[p] = liveCount(merged.items);
    }
    await prim.write(metaPath(id), { meta: { ...(metaFile.meta || {}), ...(meta || {}) }, shards: [...shards], counts });
  }

  // Cheap live-item count for the "Load from store" badge: sum the per-period counts in _meta (one read), not a
  // full multi-shard reassembly. Falls back to a real count for a legacy file or pre-counts shards.
  async function countLive(id) {
    const meta = await prim.read(metaPath(id)).catch(() => null);
    if (meta && meta.counts) return Object.values(meta.counts).reduce((a, b) => a + (b || 0), 0);
    const legacy = await prim.read(legacyPath(id)).catch(() => null);
    if (legacy && legacy.items) return liveCount(legacy.items);
    let n = 0;
    for (const p of await shardPeriods(id)) { const s = await prim.read(shardPath(id, p)).catch(() => null); if (s) n += liveCount(s.items); }
    return n;
  }

  // Every stored source id: a sharded folder OR a legacy single file at the store root.
  async function listSources() {
    const ids = new Set();
    for (const k of await prim.listChildren('').catch(() => [])) {
      if (k.isDir) ids.add(k.name);
      else if (/\.json$/.test(k.name)) ids.add(k.name.slice(0, -5));
    }
    return [...ids];
  }

  // Fully remove a source (used by deleteSource / orphan cleanup): drop the whole folder if the backend can,
  // else remove each shard + meta, then the legacy file.
  async function clearSource(id) {
    if (typeof prim.removeDir === 'function') { await prim.removeDir(id).catch(() => {}); }
    else { for (const p of await shardPeriods(id)) await prim.remove(shardPath(id, p)).catch(() => {}); await prim.remove(metaPath(id)).catch(() => {}); }
    await prim.remove(legacyPath(id)).catch(() => {});
  }

  return { loadSource, saveSource, appendItems, listSources, clearSource, countLive };
}

export const _internals = { periodOf, metaPath, shardPath, legacyPath, UNDATED };
