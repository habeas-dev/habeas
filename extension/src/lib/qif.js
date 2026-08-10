// QIF projection of the canonical store — "extract once → canonical store → project to anything"
// (docs/canonical-store.md). QIF exists for one reason CSV cannot cover: DESKTOP finance applications
// (GnuCash, HomeBank, KMyMoney, MoneyDance, Quicken) have no way to RECEIVE a push — their only inlet is a
// file, and QIF is the lingua franca of that world. So this is a second view of the same records, not a
// second copy of the data: no re-extraction, no network, and the generator is pure (no I/O, no DOM, no
// chrome.*) — the UI merely hands the result to a download.
//
// The projection itself is NOT re-implemented here: `recordToRow` (lib/csv.js) already maps every schema
// (receipt@1 / invoice@1 / transaction@1 / investment@1|@2) onto date/description/amount/currency/account/
// category, and having two exports disagree about what "the amount" is would be a bug factory.
//
// Format, in one paragraph: a line per field, prefixed by a one-letter code, blocks closed by a lone `^`,
// preceded by a `!Type:` header that declares what the following blocks are. Bank-like blocks use
// D(ate) T(otal) P(ayee) M(emo) L(category) N(umber); investment blocks are a different language entirely
// (see below). Zero dependencies, like the CSV module: an extension that asks to be audited should not pull
// a library to write six letters per line.
import { recordToRow, exportFileName } from './csv.js';
import { SIDE_DIR, sideKey } from './recdisplay.js';

// A `!Type:` header per section. Bank / CCard / Cash all share the same field set (they only tell the
// importer what KIND of account the block belongs to); investments do not (see INVST_ACTIONS).
export const QIF_HEADERS = { bank: '!Type:Bank', ccard: '!Type:CCard', cash: '!Type:Cash', invst: '!Type:Invst' };

const has = (v) => v != null && v !== '';

// --- Escaping ----------------------------------------------------------------------------------------
//
// QIF has NO quoting mechanism: it is line-oriented, so a value containing a line break would be read as a
// new field — or, worse, a lone `^` on its own line would end the block early and split one movement into
// two. There is nothing to escape WITH, so the only safe move is to neutralize the break: CR/LF collapse to
// a single space (the text stays readable, the record stays one record). Nothing else is touched — a `;`,
// a quote or an accent are ordinary characters here.
export function qifEscape(value) {
  if (value == null) return '';
  let s;
  if (typeof value === 'string') s = value;
  else if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'object') { try { s = JSON.stringify(value); } catch (e) { s = String(value); } }
  else s = String(value);
  return s.replace(/[\r\n]+/g, ' ').trim();
}

// --- Dates -------------------------------------------------------------------------------------------
//
// QIF is famously ambiguous about date order: files written by US Quicken are MM/DD/YYYY, European exports
// are DD/MM/YYYY, and the format itself says nothing — GnuCash literally ASKS the user which one a file
// uses. So it cannot be inferred, only declared: the caller picks, DD/MM/YYYY by default (the audience these
// files are written for). A date that is not the store's ISO shape is emitted verbatim rather than guessed.
export function qifDate(value, order = 'DMY') {
  const s = qifEscape(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const [, y, mo, d] = m;
  return order === 'MDY' ? `${mo}/${d}/${y}` : `${d}/${mo}/${y}`;
}

// --- Amounts -----------------------------------------------------------------------------------------
//
// ALWAYS a dot decimal mark and never a thousands separator — unlike the CSV export, this is deliberately
// NOT configurable. A CSV may be opened by a PERSON in a spreadsheet whose locale wants "1234,56"; a QIF is
// only ever read by another APPLICATION, and a comma there is not a decimal mark to any importer: it either
// truncates the amount or rejects the line. The `Decimals:` selector in the store inspector therefore
// applies to CSV alone.
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!has(value)) return null;
  const n = Number(String(value).replace(/\s/g, ''));
  return Number.isFinite(n) ? n : null;
}
export function qifAmount(value) {
  const n = typeof value === 'number' ? value : toNumber(value);
  if (n == null) return null;
  const s = String(n);
  if (s.includes('e') || s.includes('E')) return n.toFixed(2); // no exponent notation in a QIF amount
  const decimals = (s.split('.')[1] || '').length;
  return n.toFixed(Math.min(Math.max(decimals, 2), 8)); // 2 decimals minimum, never rounded away
}

// --- Which records are securities --------------------------------------------------------------------
//
// investment@2 says so outright (`recordType`); investment@1 has no discriminator, but `instrument`/`units`/
// `price` are RESERVED keys that only that schema puts at the top level of a record (a transaction@1 record
// that mapped them would have them dropped, not promoted), so their presence is a reliable signal.
// A broker CASH movement (interest/deposit/withdrawal/fee/tax on the settlement account) is NOT a security
// operation: it is an ordinary account movement and exports as one, in the bank section.
export function isSecuritiesRecord(record) {
  const r = record || {};
  if (r.recordType === 'trade') return true;
  if (r.recordType === 'cash') return false;
  return has(r.instrument) || has(r.units) || has(r.price);
}

// --- Bank-like blocks --------------------------------------------------------------------------------

// The account KIND a record belongs to, which is all the `!Type:` header of a bank section declares.
// `category === 'card'` is what a card source stamps on every movement (its adapter/stream category), and a
// card account's label ("WiZink Oro 8765", "Tarjeta …") is the other reliable tell. A shop receipt has no
// account behind it at all — it is a till ticket — so it lands in Cash rather than pretending to be a bank
// movement. Everything else is Bank, the neutral default.
const CARD_RE = /(card|tarjeta|visa|mastercard|maestro|amex|american express|cr[ée]dit)/i;
export function accountTypeOf(record) {
  const r = record || {};
  const acct = r.account && typeof r.account === 'object'
    ? qifEscape(r.account.name || r.account.iban || r.account.last4 || '')
    : qifEscape(r.account || r.group || '');
  if (r.category === 'card' || (acct && CARD_RE.test(acct))) return 'ccard';
  if (!acct && has(r.total) && (has(r.store) || has(r.storeName))) return 'cash';
  return 'bank';
}

// Sign convention: in QIF a negative T is money OUT. `direction` (which transaction@1 always carries) is
// authoritative; investment@2 cash records carry a `kind` instead, whose direction is the same table every
// listing UI already uses (recdisplay.js). With neither, a receipt/invoice `total` is money SPENT — a shop
// ticket for 18.90 is an expense, and emitting it as +18.90 would book every purchase as income — while an
// already-negative total (a refund) keeps its sign. Anything else is passed through as captured.
function signedAmount(record, n) {
  const dir = String(record.direction || '').toLowerCase();
  const side = SIDE_DIR[sideKey(record)];
  if (dir === 'debit' || dir === 'out' || side === 'out') return -Math.abs(n);
  if (dir === 'credit' || dir === 'in' || side === 'in') return Math.abs(n);
  if (has(record.total)) return n > 0 ? -n : n;
  return n;
}

// One record → one bank-like block. Built on top of the CSV row so both exports agree on what the date, the
// description and the amount of a record are.
export function recordToBankEntry(record, opts = {}) {
  const r = record || {};
  const row = recordToRow(r);
  const n = toNumber(row.amount);
  const payee = qifEscape(row.description);
  const counterparty = qifEscape(r.counterparty);
  return {
    kind: 'bank',
    type: accountTypeOf(r),
    currency: qifEscape(row.currency),
    date: qifDate(row.date, opts.dateOrder),
    // A record with no usable amount (an invoice whose total the source never exposed) still carries a date,
    // a payee and a memo worth importing, so it is kept with an explicit 0.00 — visibly a stub to fix, not a
    // silently invented number. QIF has no per-transaction currency or balance field: the running
    // `balanceAfter` is dropped (the importer recomputes it) and a foreign currency goes to the memo below.
    amount: qifAmount(n == null ? 0 : signedAmount(r, n)),
    payee,
    // The memo carries what QIF has no field for: the counterparty when it is not already the payee, and the
    // source id, so a merged export of several sources stays attributable.
    memoParts: [counterparty && counterparty !== payee ? counterparty : '', qifEscape(row.source)],
    category: qifEscape(row.category),
    number: qifEscape(r.number),
  };
}

// --- Investment blocks -------------------------------------------------------------------------------
//
// A `!Type:Invst` block speaks a different language: D(ate) N(action) Y(security) I(price per share)
// Q(quantity) T(total) O(commission) M(emo). The ACTION is what makes it meaningful, and it cannot be
// guessed: a record whose operation is unknown is left out and counted, because a Buy imported as a Sell is
// worse than a missing line.
export const INVST_ACTIONS = {
  buy: 'Buy', purchase: 'Buy', compra: 'Buy',
  sell: 'Sell', sale: 'Sell', venta: 'Sell',
  dividend: 'Div', div: 'Div', dividendo: 'Div',
  reinvest: 'ReinvDiv', reinvest_dividend: 'ReinvDiv', reinvdiv: 'ReinvDiv',
  interest: 'IntInc', intinc: 'IntInc',
  split: 'StkSplit', stock_split: 'StkSplit', stksplit: 'StkSplit',
  transfer_in: 'ShrsIn', shrsin: 'ShrsIn',
  transfer_out: 'ShrsOut', shrsout: 'ShrsOut',
  fee: 'MiscExp', commission: 'MiscExp',
  tax: 'MiscExp',
};
// Actions that describe a SHARE movement: without a quantity they are not importable as an investment
// operation (a Buy of nothing). Income actions (Div/IntInc) legitimately carry no quantity.
const NEEDS_UNITS = new Set(['Buy', 'Sell', 'ReinvDiv', 'ShrsIn', 'ShrsOut']);

// The security's human name — `Y` is a NAME, not an identifier. instrument.name first, then the ticker, and
// the ISIN only as a last resort (an importer matches securities by this string, and "IE00B4L5Y983" is a
// worse register entry than "iShares Core MSCI World"). When the name won the slot, the ISIN goes to the
// memo, where it identifies the security without displacing anything.
export function securityOf(record) {
  const r = record || {};
  const ins = r.instrument;
  if (typeof ins === 'string' || typeof ins === 'number') return { name: qifEscape(ins), isin: qifEscape(r.isin) };
  const o = ins && typeof ins === 'object' ? ins : {};
  const isin = qifEscape(o.isin || r.isin);
  return { name: qifEscape(o.name) || qifEscape(o.ticker) || isin, isin };
}

// One securities record → one investment block, or null when it cannot be expressed honestly.
export function recordToInvstEntry(record, opts = {}) {
  const r = record || {};
  const row = recordToRow(r);
  const action = INVST_ACTIONS[sideKey(r)];
  const { name, isin } = securityOf(r);
  const units = toNumber(r.units);
  // Total: the settlement figure buildRecord emits for investment@2 (netAmount, else grossAmount) or
  // investment@1's flat `amount` — recordToRow already picks that chain. In an investment block T is the
  // AMOUNT of the operation and the action carries the direction, so it is unsigned.
  const total = toNumber(row.amount);
  // Not enough to be sure ⇒ leave it out (the caller counts it) rather than emit an invented operation.
  if (!action || !name || total == null) return null;
  if (NEEDS_UNITS.has(action) && units == null) return null;
  const price = toNumber(r.price);
  const commission = toNumber(r.commission);
  const tax = toNumber(r.taxWithheld);
  return {
    kind: 'invst',
    type: 'invst',
    currency: qifEscape(row.currency),
    date: qifDate(row.date, opts.dateOrder),
    action,
    security: name,
    price: price == null ? '' : qifAmount(price),
    units: units == null ? '' : qifAmount(units),
    amount: qifAmount(Math.abs(total)),
    commission: commission == null ? '' : qifAmount(Math.abs(commission)),
    // QIF has no field for withholding tax on a dividend, and putting it in O (commission) would corrupt the
    // cost basis every importer computes from that field. It is stated in the memo instead — visible to the
    // user, harmless to the maths — together with the ISIN when the name took the Y slot, and the source id.
    memoParts: [
      isin && isin !== name ? `ISIN ${isin}` : '',
      tax != null && tax !== 0 ? `tax withheld ${qifAmount(Math.abs(tax))}` : '',
      qifEscape(row.source),
    ],
  };
}

// --- File assembly -----------------------------------------------------------------------------------

// The currency most of a section is in. QIF carries no currency anywhere, so the file is implicitly in ONE
// currency: the odd record in another one gets it stated in its memo instead of being read as if it were the
// same money.
function dominantCurrency(entries) {
  const count = new Map();
  for (const e of entries) if (e.currency) count.set(e.currency, (count.get(e.currency) || 0) + 1);
  let best = '', n = 0;
  for (const [c, k] of count) if (k > n) { best = c; n = k; }
  return best;
}

// A bank section has ONE `!Type:` header for all its blocks, so a mixed export cannot declare a per-record
// account kind: the header is used when every block agrees, and falls back to Bank otherwise — the neutral
// choice, which is also what the importer asks the user about anyway.
function bankHeader(entries) {
  const types = new Set(entries.map((e) => e.type));
  return QIF_HEADERS[types.size === 1 ? [...types][0] : 'bank'];
}

function memoOf(entry, currency) {
  const parts = [...(entry.memoParts || [])];
  if (entry.currency && currency && entry.currency !== currency) parts.push(entry.currency);
  return parts.filter(Boolean).join(' · ');
}

function emit(lines, entry, currency) {
  if (entry.date) lines.push('D' + entry.date);
  if (entry.kind === 'invst') {
    lines.push('N' + entry.action);
    lines.push('Y' + entry.security);
    if (entry.price) lines.push('I' + entry.price);
    if (entry.units) lines.push('Q' + entry.units);
    lines.push('T' + entry.amount);
    if (entry.commission) lines.push('O' + entry.commission);
  } else {
    lines.push('T' + entry.amount);
    if (entry.payee) lines.push('P' + entry.payee);
  }
  const memo = memoOf(entry, currency);
  if (memo) lines.push('M' + memo);
  if (entry.kind !== 'invst') {
    if (entry.category) lines.push('L' + entry.category);
    if (entry.number) lines.push('N' + entry.number);
  }
  lines.push('^');
}

// Records → QIF text. Returns { text, exported, skipped } so the caller can tell the user how many records
// could not be expressed (an investment operation whose action is unknown) instead of losing them silently.
// opts: { dateOrder: 'DMY' | 'MDY', eol }.
//
// ONE file with TWO sections (bank blocks first, then `!Type:Invst`), because a `!Type:Invst` block cannot
// live under a bank header — the letters mean different things there (N is an action, not a cheque number).
// A QIF file is a stream of headers, each governing the blocks that follow it, and the importers that matter
// here (GnuCash, and Quicken's own format definition) switch as they read, so sections in one file import
// as two account registers. Splitting into two downloads would only make the user import twice.
export function recordsToQif(records, opts = {}) {
  const eol = opts.eol || '\r\n';
  const dateOrder = opts.dateOrder === 'MDY' ? 'MDY' : 'DMY';
  const bank = [];
  const invst = [];
  let skipped = 0;
  for (const record of records || []) {
    if (isSecuritiesRecord(record)) {
      const e = recordToInvstEntry(record, { dateOrder });
      if (e) invst.push(e); else skipped++;
      continue;
    }
    bank.push(recordToBankEntry(record, { dateOrder }));
  }
  const lines = [];
  if (bank.length) {
    const currency = dominantCurrency(bank);
    lines.push(bankHeader(bank));
    for (const e of bank) emit(lines, e, currency);
  }
  if (invst.length) {
    const currency = dominantCurrency(invst);
    lines.push(QIF_HEADERS.invst);
    for (const e of invst) emit(lines, e, currency);
  }
  // No BOM: unlike a spreadsheet opened by a person, a QIF is parsed by an importer, and several of them
  // read the BOM as part of the first header ("﻿!Type:Bank") and reject the file.
  return { text: lines.length ? lines.join(eol) + eol : '', exported: bank.length + invst.length, skipped };
}

// habeas-<source>-YYYY-MM-DD.qif — same naming as the CSV export, same sanitizing of the source id.
export function qifFileName(sourceId, date) {
  return exportFileName(sourceId, date, 'qif');
}
