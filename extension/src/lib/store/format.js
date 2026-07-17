// Canonical store — portable, self-contained format (see docs/canonical-store.md). Keyed by source then
// by internalId so merges are a union by id (data is append-mostly). Pure functions only: no I/O, no clock
// — callers stamp `at` — so the format is trivially testable and identical across every backend.
//
//   store[sourceId] = { meta, items: { [internalId]: entry } }
//   entry = { record, docAvailable?, gone?, goneReason?, goneAt?, at }
//
// Tombstones (`gone`) are never hard-deleted, so an enumeration glitch can't resurrect an item as "new".

// Latest-timestamp of an entry (a captured `at` or a tombstone `goneAt`) — the last-write-wins clock.
const ts = (e) => (e && (e.goneAt && e.goneAt > (e.at || '') ? e.goneAt : e.at)) || '';

// Keep only the known entry fields (drop anything a caller passed by accident).
function cleanEntry(e) {
  const o = { record: e.record, at: e.at || '' };
  if (e.docAvailable != null) o.docAvailable = !!e.docAvailable;
  if (e.gone) { o.gone = true; o.goneReason = e.goneReason || 'unknown'; o.goneAt = e.goneAt || e.at || ''; }
  // srcVersion: the SOURCE (adapter) version that last built/re-processed this record. Store metadata (NOT part
  // of the delivered record), so a future migration knows what normalization each record was last touched with
  // — e.g. whether a field is in an older scale — without re-deriving. Absent = unknown/legacy (treat as oldest).
  if (e.srcVersion != null && e.srcVersion !== '') o.srcVersion = String(e.srcVersion);
  return o;
}

// Merge two entries for the same id: the one with the later timestamp wins wholesale (LWW register). A
// later tombstone wins over an older capture; a genuinely-later re-capture un-tombstones (item reappeared).
function mergeEntry(a, b) { return ts(b) >= ts(a) ? cleanEntry(b) : cleanEntry(a); }

export function emptySource(meta) { return { meta: meta || {}, items: {} }; }

// Merge `entries` (each { internalId, record, at, docAvailable?, gone?, goneReason?, goneAt? }) into a
// source's data (creating it if absent). Returns the same object (mutated) for convenience.
export function mergeItems(sourceData, entries, meta) {
  const s = sourceData && sourceData.items ? sourceData : emptySource(meta);
  if (meta) s.meta = { ...s.meta, ...meta };
  for (const e of entries || []) {
    if (!e || e.internalId == null) continue;
    const id = String(e.internalId);
    const next = cleanEntry(e);
    s.items[id] = s.items[id] ? mergeEntry(s.items[id], next) : next;
  }
  return s;
}

// Union two whole sources (for moving/rehydrating a store between backends). Never clobbers; merges by id.
export function mergeSources(into, from) {
  const s = into && into.items ? into : emptySource(from && from.meta);
  if (from && from.meta) s.meta = { ...from.meta, ...s.meta };
  for (const [id, e] of Object.entries((from && from.items) || {})) s.items[id] = s.items[id] ? mergeEntry(s.items[id], e) : cleanEntry(e);
  return s;
}

// Project a source's live records for a sink: not gone, not already delivered (ledger map), and accepted
// (predicate over the record). Newest first by record.date. This is the data a projection/consumer gets.
export function project(sourceData, { delivered, accepts } = {}) {
  if (!sourceData || !sourceData.items) return [];
  const out = [];
  for (const [id, e] of Object.entries(sourceData.items)) {
    if (e.gone) continue;
    if (delivered && delivered[id]) continue;
    if (accepts && !accepts(e.record)) continue;
    out.push(e.record);
  }
  return out.sort((a, b) => ((a && a.date) || '') < ((b && b.date) || '') ? 1 : -1);
}

// Per-sink derived views over a source (gone × ledger). Computed, never stored.
export function views(sourceData, delivered) {
  const d = delivered || {};
  const v = { pending: [], archived: [], missed: [], live: 0, gone: 0 };
  for (const [id, e] of Object.entries((sourceData && sourceData.items) || {})) {
    if (e.gone) { v.gone++; (d[id] ? v.archived : v.missed).push(id); }
    else { v.live++; if (!d[id]) v.pending.push(id); }
  }
  return v;
}
