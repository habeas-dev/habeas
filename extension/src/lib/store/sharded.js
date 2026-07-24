// Canonical store — generic PERIOD-SHARDED layer. One big blob per source becomes month shards so a source
// that grows to thousands of items (Amazon) is no longer one ever-growing JSON that every checkpoint rewrites
// in full (O(n²) bandwidth). A write touches ONLY the month shards its batch spans.
//
//   shard "2025-01" = { items: { [internalId]: entry } }   ← items whose record.date is 2025-01
//   shard "_undated" = items with no parseable YYYY-MM date
//   shard "_meta"    = { meta }                             ← the source's own metadata (NOT derived data)
//
// NO derived/cached data lives in the store — the store holds only canonical records + the source meta. The
// "Load from store" badge asks hasItems() (an existence probe over the shard listing), never a stored count.
//
// Transparent to callers: loadSource() reassembles the shards into the same { meta, items } shape as before, so
// format.js, the Archive and consumers are unchanged. A legacy single blob is REFORMATTED into shards on load
// (one-time) — opening the Archive migrates it — except on a passive read (interactive:false), which never writes.
//
// A backend supplies SEMANTIC ops over (sourceId, shardName); all period logic lives here. Names are opaque
// strings the backend maps to its own layout (a file `<name>.json`, an IDB key `<id>/<name>`, a Drive file…):
//   readShard(id,name)->obj|null  writeShard(id,name,obj)  removeShard(id,name)
//   listShardNames(id)->[name]  (excludes _meta)   listSourceIds()->[id]
//   readLegacy(id)->obj|null   removeLegacy(id)   removeSource(id)
import { emptySource, mergeItems, mergeSources } from './format.js';

const META = '_meta';
const UNDATED = '_undated';
// Run `fn` over `items` with at most `cap` in flight; returns results aligned with the input order.
async function mapLimit(items, cap, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, worker));
  return out;
}
// Shard bucket for an entry, from record.date: YYYY-MM (a bare date or an ISO datetime); a YEAR-only date (some
// sources — Amazon — expose only the year in their listing) buckets by year; anything else is _undated.
function periodOf(entry) {
  const d = (entry && entry.record && entry.record.date) || '';
  if (/^\d{4}-\d{2}/.test(d)) return String(d).slice(0, 7); // YYYY-MM
  if (/^\d{4}(\D|$)/.test(d)) return String(d).slice(0, 4);  // year-only → a year shard (not "undated")
  return UNDATED;
}

export function makeShardedStore(prim) {
  // Reassemble a source → { meta, items } (or null). Two things heal on load (one saveSource re-splits into the
  // right shards): a legacy single blob is reformatted into shards, AND entries sitting in the WRONG shard —
  // e.g. year-dated records an older periodOf dumped into _undated — are moved to their correct shard. So simply
  // opening the Archive fixes both. Skipped on a passive read (opts.interactive === false, e.g. a badge probe).
  async function loadSource(id, opts) {
    const legacy = await prim.readLegacy(id).catch(() => null);
    const names = await prim.listShardNames(id).catch(() => []);
    const meta = await prim.readShard(id, META).catch(() => null);
    if (!legacy && !names.length && !meta) return null; // nothing stored for this source
    let data = emptySource((meta && meta.meta) || (legacy && legacy.meta) || {});
    let heal = false;
    if (legacy && legacy.items) { data = mergeSources(data, legacy); heal = true; } // legacy blob → reformat into shards
    // Read every month shard CONCURRENTLY (a source with years of history has dozens; sequential round-trips to a
    // cloud backend were the slow part of opening it). Bounded fan-out so a cloud backend isn't hammered.
    const shards = await mapLimit(names, 8, (n) => prim.readShard(id, n).catch(() => null));
    for (let k = 0; k < names.length; k++) {
      const sh = shards[k]; if (!sh || !sh.items) continue;
      data = mergeSources(data, { meta: {}, items: sh.items });
      if (!heal) for (const e of Object.values(sh.items)) if (periodOf(e) !== names[k]) { heal = true; break; } // an entry in the wrong shard
    }
    if (heal && (!opts || opts.interactive !== false)) {
      try { await saveSource(id, data); } catch (e) { /* no token/permission for a write → serve the read-only assembly */ }
    }
    return data;
  }

  // Split items into month buckets. Returns { byPeriod, meta }.
  function bucket(data) {
    const byPeriod = {};
    for (const [iid, e] of Object.entries((data && data.items) || {})) { const p = periodOf(e); (byPeriod[p] || (byPeriod[p] = {}))[iid] = e; }
    return byPeriod;
  }

  // Full write (migrate/move/clear/repair/reformat): re-split into month shards, prune stale ones, drop legacy.
  async function saveSource(id, data) {
    const byPeriod = bucket(data);
    const want = new Set(Object.keys(byPeriod));
    for (const n of await prim.listShardNames(id).catch(() => [])) if (!want.has(n)) await prim.removeShard(id, n).catch(() => {}); // prune emptied months
    for (const p of want) await prim.writeShard(id, p, { items: byPeriod[p] });
    const meta = (data && data.meta) || {};
    if (Object.keys(meta).length) await prim.writeShard(id, META, { meta }); else await prim.removeShard(id, META).catch(() => {});
    await prim.removeLegacy(id).catch(() => {}); // superseded by the shards
  }

  // Incremental write (the hot path): route entries to their month shards; read-merge-write ONLY those shards.
  async function appendItems(id, entries, meta) {
    if (!entries || !entries.length) return;
    const legacy = await prim.readLegacy(id).catch(() => null);
    if (legacy && legacy.items) await saveSource(id, mergeItems(legacy, [], meta)); // one-time split of the legacy blob
    const byPeriod = {};
    for (const e of entries) { if (!e || e.internalId == null) continue; const p = periodOf(e); (byPeriod[p] || (byPeriod[p] = [])).push(e); }
    for (const [p, es] of Object.entries(byPeriod)) {
      const cur = (await prim.readShard(id, p).catch(() => null)) || { items: {} };
      const merged = mergeItems({ meta: {}, items: cur.items || {} }, es, null);
      await prim.writeShard(id, p, { items: merged.items });
    }
    // MOVE, don't duplicate: a document whose date became more precise (Amazon's year → the real month once the
    // detail is analyzed) is written to its month shard above; here we drop its old copy from any COARSER shard
    // (the year shard, or _undated) so it lives in exactly one place. Dates only ever get finer, so month
    // siblings are never touched. Coarser shards usually don't exist (well-dated sources) → cheap misses.
    const drop = {};
    for (const [p, es] of Object.entries(byPeriod)) {
      const coarser = /^\d{4}-\d{2}/.test(p) ? [p.slice(0, 4), UNDATED] : /^\d{4}$/.test(p) ? [UNDATED] : [];
      for (const c of coarser) for (const e of es) (drop[c] || (drop[c] = new Set())).add(String(e.internalId));
    }
    for (const [c, idset] of Object.entries(drop)) {
      const sh = await prim.readShard(id, c).catch(() => null); if (!sh || !sh.items) continue;
      let changed = false; for (const iid of idset) if (sh.items[iid]) { delete sh.items[iid]; changed = true; }
      if (changed) { if (Object.keys(sh.items).length) await prim.writeShard(id, c, { items: sh.items }); else await prim.removeShard(id, c).catch(() => {}); }
    }
    if (meta && Object.keys(meta).length) { // keep the source meta current (small; not derived data)
      const cur = (await prim.readShard(id, META).catch(() => null)) || { meta: {} };
      await prim.writeShard(id, META, { meta: { ...(cur.meta || {}), ...meta } });
    }
  }

  async function listSources() { return (await prim.listSourceIds()).filter((id) => !String(id).startsWith('_')); } // hide reserved ids (e.g. _config)

  // A device-portable CONFIG snapshot lives alongside the documents (so a cloud-backed store carries the setup to
  // another machine). It's a single reserved blob (`_config/config`), NOT sharded item data — kept out of the
  // source listing above so the Archive never renders or orphan-prunes it.
  const CONFIG_ID = '_config', CONFIG_SHARD = 'config';
  async function getConfig() { try { return await prim.readShard(CONFIG_ID, CONFIG_SHARD); } catch (e) { return null; } }
  async function putConfig(snapshot) { try { await prim.writeShard(CONFIG_ID, CONFIG_SHARD, snapshot); return true; } catch (e) { return false; } }

  async function clearSource(id) { await prim.removeSource(id).catch(() => {}); await prim.removeLegacy(id).catch(() => {}); }

  // Cheap presence hint for the "Load from store" badge — an existence probe, never a stored count: any shard
  // present (or a legacy blob with items) ⇒ the store has records for this source. One listing, no shard reads.
  async function hasItems(id) {
    const names = await prim.listShardNames(id).catch(() => []);
    if (names.length) return true;
    const legacy = await prim.readLegacy(id).catch(() => null);
    return !!(legacy && legacy.items && Object.keys(legacy.items).length);
  }

  return { loadSource, saveSource, appendItems, listSources, clearSource, hasItems, getConfig, putConfig };
}

// Adapt a PATH-based backend (folder/dropbox/webdav/s3) to the semantic shard ops. The backend supplies plain
// file I/O over store-root-relative paths — shard names become `<id>/<name>.json`, the legacy blob `<id>.json`:
//   readJson(path)->obj|null   writeJson(path,obj)   removePath(path)   listDir(dir)->[{name,isDir}]
//   removeDir(dir)  (optional — else removeSource deletes each child file)
export function pathPrim(io, root = '') {
  const base = String(root).replace(/\/+$/, '');
  const join = (...parts) => [base, ...parts].filter((x) => x !== '' && x != null).join('/');
  const shardFile = (id, name) => join(id, name + '.json');
  const legacyFile = (id) => join(id + '.json');
  const isShard = (name) => /\.json$/.test(name) && name !== META + '.json';
  return {
    readShard: (id, name) => io.readJson(shardFile(id, name)),
    writeShard: (id, name, obj) => io.writeJson(shardFile(id, name), obj),
    removeShard: (id, name) => io.removePath(shardFile(id, name)),
    async listShardNames(id) {
      return (await io.listDir(join(id)).catch(() => [])).filter((k) => !k.isDir && isShard(k.name)).map((k) => k.name.slice(0, -5));
    },
    async listSourceIds() {
      const s = new Set();
      for (const k of await io.listDir(join()).catch(() => [])) { if (k.isDir) s.add(k.name); else if (/\.json$/.test(k.name)) s.add(k.name.slice(0, -5)); }
      return [...s];
    },
    readLegacy: (id) => io.readJson(legacyFile(id)),
    removeLegacy: (id) => io.removePath(legacyFile(id)),
    async removeSource(id) {
      if (io.removeDir) await io.removeDir(join(id)).catch(() => {});
      else for (const k of await io.listDir(join(id)).catch(() => [])) if (!k.isDir) await io.removePath(join(id, k.name)).catch(() => {});
      await io.removePath(legacyFile(id)).catch(() => {});
    },
  };
}

export const _internals = { periodOf, META, UNDATED };
