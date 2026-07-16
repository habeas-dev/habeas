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
  const extract = (spec, cur) => {
    if (!spec || !spec.re || (cur != null && cur !== '')) return undefined;
    const src = String((doc[spec.from] != null ? doc[spec.from] : (doc._raw && doc._raw[spec.from])) ?? '');
    for (const p of (Array.isArray(spec.re) ? spec.re : [spec.re])) {
      try {
        const m = new RegExp(p, spec.flags || '').exec(src);
        if (m && m[1] != null && m[1].trim() !== '') return m[1].trim();
      } catch (e) { /* a bad pattern must never break extraction */ }
    }
    return undefined;
  };
  // counterparty: { from, re: "…(group1)…" | [...], flags? } — the merchant/beneficiary out of free text.
  const cp = extract(n.counterparty, doc.counterparty);
  if (cp !== undefined) doc.counterparty = cp;
  // fields: { <name>: { from, re, flags? } } — extract any named field (e.g. a security ISIN out of an icon
  // path "logos/IE00…/v2"). Only fills when empty, so a directly-mapped value always wins.
  for (const [name, spec] of Object.entries(n.fields || {})) {
    const v = extract(spec, doc[name]);
    if (v !== undefined) doc[name] = v;
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
  const amount = record.amount != null ? num(record.amount) : (record.total != null ? num(record.total) : num(record.netAmount));
  const counterparty = record.counterparty || nameOf(record.store) || nameOf(record.issuer) || nameOf(record.party) || record.storeName || nameOf(record.instrument) || record.instrument || '';
  const out = {
    id: record.internalId,
    date: record.date, // the booked date — Cuéntamo maps this to Transaction.bookedDate
    amount,
    currency: record.currency || 'EUR',
    direction: record.direction || (typeof amount === 'number' ? (amount < 0 ? 'debit' : 'credit') : undefined),
    description: record.description || '',
    counterparty,
    category: record.category,
    type: record.type,
    account: acctObj(record),
    number: record.number,
    source: record.source,
  };
  // Bank movement extras (Cuéntamo contract) — added only when the source captured them, so canonical
  // records that don't carry them keep the same key set.
  if (record.valueDate != null && record.valueDate !== '') out.valueDate = record.valueDate;
  if (record.balanceAfter != null && record.balanceAfter !== '') out.balanceAfter = num(record.balanceAfter);
  if (record.extra != null) out.extra = record.extra;
  return out;
}

// Structured account for the canonical finance shape (Cuéntamo): { iban?, last4?, groupId?, currency? }.
// Derives `last4` from an IBAN / masked-PAN string and `groupId` from the source's group id. A record that
// already carries a structured account object is passed through untouched. When nothing structured can be
// derived it falls back to the historical string (`account || group`), so non-bank canonical records are
// unaffected.
function acctObj(record) {
  const raw = record.account;
  if (raw && typeof raw === 'object') return raw;
  const str = typeof raw === 'string' ? raw : '';
  const compact = str.replace(/\s+/g, '').toUpperCase();
  const iban = /^[A-Z]{2}\d{2}[A-Z0-9]*$/.test(compact) ? compact : undefined;
  // last4, most-reliable first: (1) the IBAN's own last digits; (2) the group label's trailing 4 digits —
  // a grouped card/bank label renders "<name> <last4>" from the group mask, i.e. the number the user
  // recognizes (a card's last four, not an opaque internal account id); (3) the account string's own last
  // 4 digits (a masked PAN like "**** 8765", or a plain account number when it IS the account).
  const digitsOf = (s) => String(s || '').replace(/\D+/g, '');
  const labelTail = String(record.group || '').match(/(\d{4})\s*$/);
  const acctDigits = digitsOf(str);
  const last4 = (iban ? digitsOf(iban).slice(-4) : undefined)
    || (labelTail ? labelTail[1] : undefined)
    || (acctDigits.length >= 4 ? acctDigits.slice(-4) : undefined);
  const groupId = record.group != null && record.group !== '' ? String(record.group) : undefined;
  const o = {};
  if (iban) o.iban = iban;
  if (last4) o.last4 = last4;
  if (groupId) o.groupId = groupId;
  // currency qualifies the account only once we actually have an identifier — it never alone turns a
  // receipt (no account/group) into a structured account.
  if (Object.keys(o).length && record.currency) o.currency = record.currency;
  return Object.keys(o).length ? o : (raw || record.group || '');
}
