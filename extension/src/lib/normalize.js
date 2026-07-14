// Light, DECLARATIVE data normalization (adapters stay data, not code). Two jobs:
//  1) applyNormalize(doc, adapter): declared per-adapter derivations — today, extracting a clean
//     `counterparty` (merchant/beneficiary) out of a free-text field via a regex. Runs at map time, so
//     buildRecord then places the derived value in the record's own `counterparty` slot.
//  2) canonicalize(record): a UNIFORM cross-schema shape so a consumer never adapts per source — same field
//     names/types regardless of whether the origin was a transaction, receipt, invoice or investment.

// Apply an adapter's `normalize` block to a mapped doc (mutates it). Only fills fields that are still empty,
// so it never overrides a value the source mapped directly. Rules are simple + auditable (regex on a field).
export function applyNormalize(doc, adapter) {
  const n = adapter && adapter.normalize;
  if (!n || !doc) return doc;
  // counterparty: { from: "<field or raw key>", re: "…(group1)…" | ["p1","p2"], flags?: "i" }. The patterns
  // are tried in order; the first whose group 1 matches wins (a source's free text has several shapes).
  const cp = n.counterparty;
  if (cp && cp.re && (doc.counterparty == null || doc.counterparty === '')) {
    const src = String((doc[cp.from] != null ? doc[cp.from] : (doc._raw && doc._raw[cp.from])) ?? '');
    for (const p of (Array.isArray(cp.re) ? cp.re : [cp.re])) {
      try {
        const m = new RegExp(p, cp.flags || '').exec(src);
        if (m && m[1] != null && m[1].trim() !== '') { doc.counterparty = m[1].trim(); break; }
      } catch (e) { /* a bad pattern must never break extraction */ }
    }
  }
  return doc;
}

const num = (v) => (typeof v === 'number' ? v : (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : v));
const nameOf = (v) => (v && typeof v === 'object') ? (v.name || v.nombre || '') : (v == null ? '' : String(v));

// Map ANY schema record to one uniform canonical shape. Pure. `amount` is signed for transactions and the
// document total for receipts/invoices; `counterparty` collapses store/issuer/party/counterparty; `account`
// collapses account/group. Keeps `extra` (the raw passthrough) so nothing captured is lost.
export function canonicalize(record) {
  if (!record || typeof record !== 'object') return record;
  const amount = record.amount != null ? num(record.amount) : num(record.total);
  const counterparty = record.counterparty || nameOf(record.store) || nameOf(record.issuer) || nameOf(record.party) || record.storeName || record.instrument || '';
  const out = {
    id: record.internalId,
    date: record.date,
    amount,
    currency: record.currency || 'EUR',
    direction: record.direction || (typeof amount === 'number' ? (amount < 0 ? 'debit' : 'credit') : undefined),
    description: record.description || '',
    counterparty,
    category: record.category,
    type: record.type,
    account: record.account || record.group || '',
    number: record.number,
    source: record.source,
  };
  if (record.extra != null) out.extra = record.extra;
  return out;
}
