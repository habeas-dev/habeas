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
import { buildRecord } from '../sinks/format.js';
import { applyNormalize } from './normalize.js';
import { normalizeDate, normalizeAmount, minorExp } from '../runtime/inventory.js';

const MARK_KEY = 'habeas:storeMigration';
const CURRENT = 'renormalize-1'; // bump to force a re-run when normalization changes again

// Read/write sinks: cumulative-manifest, re-projectable, overwrite-safe. NOT download (ephemeral ZIP) / http
// (POST-only push) — those are one-way, so re-delivering would spam downloads / duplicate ingest POSTs.
export const RW_SINK_TYPES = new Set(['local-folder', 'drive', 'dropbox', 'webdav', 's3']);

const MONEY = new Set(['total', 'amount', 'balanceAfter', 'price', 'grossAmount', 'commission', 'taxWithheld', 'netAmount', 'units']);
const DATES = new Set(['date', 'valueDate']);
const getPath = (o, p) => String(p).split('.').reduce((x, k) => (x == null ? x : x[k]), o);

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
  const backfilled = [];
  for (const [norm, spec] of Object.entries(fields)) {
    if (doc[norm] != null && doc[norm] !== '') continue;
    if (typeof spec !== 'string' || /[{[]/.test(spec)) continue; // templated/selector path: not invertible offline
    let v = getPath(extra, spec);
    if (v == null || v === '') {
      // consumed & deduped out of extra → reuse a sibling field mapping the SAME raw path that the record kept
      // (e.g. instrumentName ↔ description, both ← "title" for Trade Republic).
      const sib = Object.entries(fields).find(([n2, s2]) => n2 !== norm && s2 === spec && record[n2] != null && record[n2] !== '');
      if (sib) v = record[sib[0]];
    }
    if (v == null || v === '') continue;
    doc[norm] = v; backfilled.push(norm);
  }
  // Normalize the FRESHLY-backfilled fields exactly like the runtime does (mapDoc). Fields the record ALREADY
  // carried are left untouched — they were normalized/scaled at store time, so re-scaling would double-count.
  for (const k of backfilled) {
    if (MONEY.has(k) && typeof doc[k] === 'string') doc[k] = normalizeAmount(doc[k]);
    if (DATES.has(k) && doc[k] != null && doc[k] !== '') doc[k] = normalizeDate(doc[k]);
  }
  const scale = eff.minorUnits ? Math.pow(10, -minorExp(doc.currency)) : eff.amountScale;
  if (scale) for (const k of backfilled) if (MONEY.has(k) && typeof doc[k] === 'number') doc[k] = doc[k] * scale;
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
    if (!data || !data.items) continue;
    let dirty = false;
    for (const entry of Object.values(data.items)) {
      if (!entry || !entry.record || entry.gone) continue;
      let out; try { out = renormalizeRecord(entry.record, eff); } catch (e) { continue; }
      if (out.changed) { entry.record = out.record; dirty = true; records++; }
    }
    if (dirty) {
      data.meta = { ...(data.meta || {}), adapterVersion: base.version || '', renormalizedAt: new Date().toISOString() };
      try { await backend.saveSource(storeKey, data); changedAdapters.add(adapterId); } catch (e) {}
    }
  }
  return { changedAdapters, records };
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
  try { await chrome.storage.local.set({ [MARK_KEY]: CURRENT }); } catch (e) {}
  return { records, changed: [...changedAdapters], resets };
}
