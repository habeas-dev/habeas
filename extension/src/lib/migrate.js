// One-time canonical-store migration: re-normalize records stored under an OLDER adapter/schema so they match
// the CURRENT normalization — the bank fields balanceAfter/valueDate, and the Trade Republic transaction@1 →
// investment@2 schema change. The store is the source of truth and sinks are projections, so converting the
// store IS the conversion. Re-normalization is best-effort and OFFLINE: each record is rebuilt from what the
// store kept (its own normalized fields + record.extra, preserved by keepRaw) with the current effective
// adapter — no re-fetch. It is idempotent (a record already in the new shape rebuilds identically) and gated
// by a marker so it runs once. After converting, the delivery ledgers of READ/WRITE sinks (the cumulative-
// manifest ones we can re-project and overwrite: local-folder/drive/dropbox/webdav/s3) are reset for the
// changed sources so the next Sync re-pushes the corrected records. Ephemeral/one-way sinks (download, http)
// are deliberately left alone — resetting them would re-trigger a pile of downloads / duplicate POSTs.
import { chrome } from './ext.js';
import { activeBackend } from './store.js';
import { getConfig } from './config.js';
import { forgetDelivered } from './state.js';
import { resolveOutput } from './outputs.js';
import { buildRecord, purgeRecords } from '../sinks/format.js';
import { readSinkRecords, writeSinkRecords } from '../sinks/sinks.js';
import { applyNormalize } from './normalize.js';
import { normalizeDate, normalizeAmount, minorExp } from '../runtime/inventory.js';

const MARK_KEY = 'habeas:storeMigration';
const CURRENT = 'renormalize-3'; // bump to force a re-run when normalization changes again (3: retire the duplicates left by the 0.10.2 identity change)

// Read/write sinks: cumulative-manifest, re-projectable, overwrite-safe. NOT download (ephemeral ZIP) / http
// (POST-only push) — those are one-way, so re-delivering would spam downloads / duplicate ingest POSTs.
export const RW_SINK_TYPES = new Set(['local-folder', 'drive', 'dropbox', 'webdav', 's3']);

const MONEY = new Set(['total', 'amount', 'balanceAfter', 'price', 'grossAmount', 'commission', 'taxWithheld', 'netAmount', 'units']);
const DATES = new Set(['date', 'valueDate']);
// Resolve a dotted path with optional array selectors `key[field=value].sub` — mirrors the runtime's get()
// so migration backfills can read nested/selected raw values (e.g. Trade Republic's units/price out of
// record.extra.detail.sections[title=Transaction].data[title=Shares].detail.text).
function getPath(obj, path) {
  if (obj == null || path == null) return undefined;
  const s = String(path);
  if (s.indexOf('.') < 0 && s.indexOf('[') < 0) return obj[s];
  return s.split('.').reduce((o, k) => {
    if (o == null) return undefined;
    const m = k.match(/^([^[]+)\[([^=\]]+)=([^\]]*)\]$/);
    if (!m) return o[k];
    const arr = o[m[1]];
    return Array.isArray(arr) ? arr.find((e) => e != null && String(getPath(e, m[2])) === m[3]) : undefined;
  }, obj);
}

// A source needs re-normalization only if its CURRENT adapter emits fields/schema that older stored records
// couldn't have carried: the investment@2 broker schema, or the new bank/broker mappings.
export function needsMigration(eff) {
  const f = (eff && eff.fields) || {};
  return /^investment@[2-9]\d*$/.test((eff && eff.schema) || '') || f.balanceAfter != null || f.valueDate != null || f.settlementAccount != null;
}

// Deterministic key-sorted JSON, so change detection ignores mere key-order differences (no spurious rewrites).
function stable(v) {
  return JSON.stringify(v, (k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) { const o = {}; for (const kk of Object.keys(val).sort()) o[kk] = val[kk]; return o; }
    return val;
  });
}

// Rebuild ONE stored record with the current effective adapter, best-effort from record + record.extra.
// Returns { record, changed }. Never throws — a record it can't improve is returned unchanged.
export function renormalizeRecord(record, eff) {
  if (!record || typeof record !== 'object' || !eff) return { record, changed: false };
  const extra = record.extra && typeof record.extra === 'object' ? record.extra : {};
  const doc = { _raw: extra };
  for (const [k, v] of Object.entries(record)) if (k !== 'extra') doc[k] = v;
  if (record.group) doc._group = { name: record.group }; // let buildRecord re-emit the group label
  const fields = eff.fields || {};
  const fromRaw = []; // ONLY the fields pulled from record.extra (raw) — these still need normalizing/scaling
  for (const [norm, spec] of Object.entries(fields)) {
    if (doc[norm] != null && doc[norm] !== '') continue;
    if (typeof spec !== 'string' || spec.indexOf('{') >= 0) continue; // templated path ({group.*}): not invertible offline
    const raw = getPath(extra, spec);
    if (raw != null && raw !== '') { doc[norm] = raw; fromRaw.push(norm); continue; }
    // consumed & deduped out of extra → reuse a sibling field mapping the SAME raw path that the record kept
    // (e.g. instrumentName ↔ description, both ← "title" for Trade Republic). This value is ALREADY normalized,
    // so it is NOT added to fromRaw — re-normalizing/re-scaling it would corrupt it (double-scale a money field).
    const sib = Object.entries(fields).find(([n2, s2]) => n2 !== norm && s2 === spec && record[n2] != null && record[n2] !== '');
    if (sib) doc[norm] = record[sib[0]];
  }
  // Normalize/scale ONLY the raw-sourced backfills, exactly like the runtime does (mapDoc). Fields the record
  // ALREADY carried (and sibling-sourced ones) are left untouched — they were normalized/scaled at store time,
  // so re-scaling would double-count.
  for (const k of fromRaw) {
    if (MONEY.has(k) && typeof doc[k] === 'string') doc[k] = normalizeAmount(doc[k]);
    if (DATES.has(k) && doc[k] != null && doc[k] !== '') doc[k] = normalizeDate(doc[k]);
  }
  const scale = eff.minorUnits ? Math.pow(10, -minorExp(doc.currency)) : eff.amountScale;
  if (scale) for (const k of fromRaw) if (MONEY.has(k) && typeof doc[k] === 'number') doc[k] = doc[k] * scale;
  applyNormalize(doc, eff); // declarative value maps (side/kind) + regex fields (isin) — fill-empty-only
  const rebuilt = buildRecord(doc, eff);
  return { record: rebuilt, changed: stable(rebuilt) !== stable(record) };
}

// Walk the canonical store and re-normalize every affected source's records in place. Returns the set of
// changed base adapter ids (for the ledger reset) and a record count. Pure I/O over the configured backend.
export async function renormalizeStore(adapters) {
  const changedAdapters = new Set();
  let records = 0;
  let backend;
  try { backend = await activeBackend(); } catch (e) { return { changedAdapters, records }; }
  let ids = [];
  try { ids = await backend.listSources(); } catch (e) { return { changedAdapters, records }; }
  for (const storeKey of ids) {
    const ci = String(storeKey).indexOf(':');
    const adapterId = ci >= 0 ? storeKey.slice(0, ci) : storeKey;
    const streamId = ci >= 0 ? storeKey.slice(ci + 1) : '';
    const base = adapters && adapters[adapterId];
    if (!base) continue;
    let eff; try { eff = resolveOutput(base, streamId); } catch (e) { eff = base; }
    if (!needsMigration(eff)) continue;
    let data; try { data = await backend.loadSource(storeKey); } catch (e) { continue; }
    if (!data || !data.items || data.__partial) continue; // a partial/failed read must not drive a pruning resave
    const ver = base.version || eff.version || '';
    let dirty = false;
    for (const entry of Object.values(data.items)) {
      if (!entry || !entry.record || entry.gone) continue;
      let out; try { out = renormalizeRecord(entry.record, eff); } catch (e) { continue; }
      if (out.changed) { entry.record = out.record; if (ver) entry.srcVersion = ver; dirty = true; records++; }
    }
    if (dirty) {
      data.meta = { ...(data.meta || {}), adapterVersion: base.version || '', renormalizedAt: new Date().toISOString() };
      try { await backend.saveSource(storeKey, data); changedAdapters.add(adapterId); } catch (e) {}
    }
  }
  return { changedAdapters, records };
}

// ---------------------------------------------------------------- superseded duplicates
//
// When a source changes HOW it identifies a movement, everything it re-lists lands in the store a second
// time under the new identity. The store is additive on purpose — nothing prunes, which is what stops a bad
// read from emptying an archive — so the old copies stay and the archive shows everything twice.
//
// The cleanup must NOT be "delete the old-looking ids". WiZink never requests a statement older than 90 days
// (that request is what triggers its SMS), so a movement past that window is never re-listed and its
// old-identity entry is the ONLY copy there is. Deleting by shape would destroy it for good.
//
// The rule is therefore about content: entries describing the SAME movement — account, day, amount, currency,
// concept — that were written by DIFFERENT source versions are one movement recorded twice, so what the
// NEWEST version wrote is kept and the rest retired. Entries from a single version are left completely alone:
// there they are what the source genuinely listed, including two real identical charges on one day. An entry
// with no newer twin is alone in its signature and is never touched, which is what protects the old archive.
const sigOf = (r) => [
  r.group == null ? '' : String(r.group),
  String(r.date || '').slice(0, 10),
  r.amount == null ? (r.total == null ? '' : String(r.total)) : String(r.amount),
  String(r.currency || ''),
  String(r.description || '').trim().toLowerCase().replace(/\s+/g, ' '),
].join('\u0000');
// Compared as plain strings: source versions are YYYY-MM-DD[.N], which sorts correctly that way, and an
// entry written before versions were stamped must count as the OLDEST rather than beat the current one.
const verOf = (e) => (e && e.srcVersion ? String(e.srcVersion) : '');

// The ids to retire. Pure function over a store's items — no I/O, so it is trivially testable and its
// behaviour on the dangerous cases is pinned rather than argued about.
export function supersededIds(items) {
  const groups = new Map();
  for (const [id, e] of Object.entries(items || {})) {
    if (!e || !e.record || e.gone) continue; // an already-retired entry is neither retired again nor revived
    const k = sigOf(e.record);
    (groups.get(k) || groups.set(k, []).get(k)).push([id, verOf(e)]);
  }
  const out = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const newest = rows.reduce((a, b) => (b[1] > a ? b[1] : a), rows[0][1]);
    if (rows.every(([, v]) => v === newest)) continue; // one version wrote them all → genuinely distinct
    for (const [id, v] of rows) if (v !== newest) out.push(id);
  }
  return out;
}

// Carry a retirement through to the DESTINATIONS. A source's index there only ever grows (mergeRecords adds
// and overwrites, never removes), so without this the archive in Dropbox goes on listing both copies for
// ever — the tidy-up would stop at this machine. Guarded in format.js#purgeRecords: no write when nothing
// matches, and a flat refusal to write an empty index. Drive is skipped (addressed by id, not path) and so
// is local-folder in the background, which has no directory handle.
async function purgeSupersededFromSinks(retiredBySource) {
  let purged = 0;
  let cfg; try { cfg = await getConfig(); } catch (e) { return 0; }
  const sinks = (cfg.sinks || []).filter((s) => RW_SINK_TYPES.has(s.type) && s.type !== 'local-folder' && s.type !== 'drive');
  if (!sinks.length) return 0;
  for (const [storeKey, ids] of retiredBySource) {
    if (!ids || !ids.size) continue;
    const ci = String(storeKey).indexOf(':');
    const adapterId = ci >= 0 ? storeKey.slice(0, ci) : storeKey;
    const ds = (cfg.datasources || []).find((d) => d.adapter === adapterId);
    const service = (ds && ds.adapter) || adapterId; // the service folder the sink wrote under
    for (const sink of sinks) {
      let recs; try { recs = await readSinkRecords(sink, { service, source: storeKey }); } catch (e) { continue; }
      const out = purgeRecords(recs, ids);
      if (!out.changed) continue;
      try { if (await writeSinkRecords(sink, out.records, { service, source: storeKey })) purged += out.removed; } catch (e) { /* a destination that refuses is left as it was */ }
    }
  }
  return purged;
}

// Retire superseded duplicates across every source in the store. Marks them `gone` (a tombstone) rather than
// deleting: the archive stops showing them, and the record of what happened survives for anyone who looks.
export async function retireSupersededDuplicates() {
  let backend, ids = [], retired = 0;
  try { backend = await activeBackend(); ids = await backend.listSources(); } catch (e) { return { retired: 0, sources: [], purged: 0 }; }
  const sources = [], retiredBySource = new Map();
  for (const storeKey of ids) {
    let data; try { data = await backend.loadSource(storeKey); } catch (e) { continue; }
    if (!data || !data.items || data.__partial) continue; // a partial read must never drive a pruning pass
    const gone = supersededIds(data.items);
    if (!gone.length) continue;
    const at = new Date().toISOString();
    for (const id of gone) { const e = data.items[id]; if (e) { e.gone = true; e.goneReason = 'superseded'; e.goneAt = e.goneAt || at; } }
    try { await backend.saveSource(storeKey, data); retired += gone.length; sources.push(storeKey); retiredBySource.set(storeKey, new Set(gone)); } catch (e) {}
  }
  // Only after the store is safely written: the destination is a projection of it, never the other way.
  let purged = 0;
  try { purged = await purgeSupersededFromSinks(retiredBySource); } catch (e) { /* best-effort */ }
  return { retired, sources, purged };
}

// Reset the delivery ledgers of READ/WRITE sinks for datasources whose adapter changed, so the next Sync
// re-projects and overwrites their manifests with the corrected records. Returns how many ledgers were reset.
export async function resetReadWriteLedgers(changedAdapters) {
  if (!changedAdapters || !changedAdapters.size) return 0;
  const cfg = await getConfig();
  const rwSinks = (cfg.sinks || []).filter((s) => RW_SINK_TYPES.has(s.type));
  if (!rwSinks.length) return 0;
  let n = 0;
  for (const ds of cfg.datasources || []) {
    if (!changedAdapters.has(ds.adapter)) continue;
    for (const sink of rwSinks) { await forgetDelivered(ds.id, sink.id); n++; }
  }
  return n;
}

// One-shot orchestrator (background startup). Gated by a marker so it runs exactly once per migration version.
export async function runStoreMigration(adapters) {
  let o; try { o = await chrome.storage.local.get(MARK_KEY); } catch (e) { o = {}; }
  if (o[MARK_KEY] === CURRENT) return { skipped: true };
  const { changedAdapters, records } = await renormalizeStore(adapters);
  const resets = await resetReadWriteLedgers(changedAdapters);
  // Retire the copies left behind when a source changed how it identifies a movement (0.10.2 did, for
  // WiZink and Revolut). Runs after re-normalization so both copies are compared in their final shape.
  let dupes = { retired: 0, sources: [], purged: 0 };
  try { dupes = await retireSupersededDuplicates(); } catch (e) { /* best-effort; never blocks startup */ }
  try { await chrome.storage.local.set({ [MARK_KEY]: CURRENT }); } catch (e) {}
  return { records, changed: [...changedAdapters], resets, retired: dupes.retired, retiredIn: dupes.sources, purged: dupes.purged };
}
