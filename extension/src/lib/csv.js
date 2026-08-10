// CSV projection of the canonical store — "extract once → canonical store → project to anything"
// (docs/canonical-store.md). A spreadsheet is just one more VIEW of the store, so this module is pure:
// no I/O, no DOM, no chrome.* — it turns normalized records (sinks/format.js#buildRecord output) into a
// CSV string, and the UI merely hands the result to a download.
//
// Zero dependencies on purpose: an auditable extension should not pull a CSV library to write commas.
import { displayName } from './recdisplay.js';

// RFC 4180: fields are separated by the delimiter, records by CRLF, a field is quoted with double quotes
// when it contains the delimiter, a quote or a line break, and an inner quote is doubled.
const NEEDS_QUOTE = /["\r\n]/;
export const BOM = '\uFEFF';

// One CSV field. Objects/arrays are JSON-encoded rather than stringified to "[object Object]", so a value
// the schema didn't flatten is still readable and nothing is silently lost.
// `decimal` only affects finite numbers: ',' renders 1234.5 as "1234,5" so that Excel in a locale whose
// decimal mark is a comma reads it as a NUMBER instead of as text. Everything else is untouched.
export function csvEscape(value, delimiter = ';', decimal = '.') {
  if (value == null) return '';
  let s;
  if (typeof value === 'string') s = value;
  else if (typeof value === 'number') {
    s = String(value);
    if (decimal === ',' && Number.isFinite(value)) s = s.replace('.', ',');
  } else if (typeof value === 'boolean') s = String(value);
  else if (value instanceof Date) s = value.toISOString();
  else { try { s = JSON.stringify(value); } catch (e) { s = String(value); } }
  if (s === '') return '';
  if (s.includes(delimiter) || NEEDS_QUOTE.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// rows: array of plain objects (keyed by column) or arrays (already positional).
// opts: { columns?, delimiter?, decimal?, bom?, eol?, header? }
//  - delimiter defaults to ';'. Excel parses a `,`-separated file as a single column under any locale whose
//    list separator is `;` (Spanish, French, German…), which is where these exports are opened by double
//    click. `,` stays available for tools that expect the RFC's own example separator.
//  - decimal defaults to '.', the right choice when another APPLICATION re-imports the file: a
//    locale-dependent decimal mark inside a machine-to-machine contract is a bug waiting to happen.
//    Pass ',' when a PERSON will open the file in a spreadsheet set to a comma locale, or every amount
//    lands as text. The two audiences want opposite things, hence the switch.
//  - a UTF-8 BOM is prepended by default: without it Excel decodes the file as the legacy ANSI codepage and
//    accented text arrives mangled ("Alimentación"). Consumers that don't want it pass { bom: false }.
export function toCsv(rows, opts = {}) {
  const delimiter = opts.delimiter || ';';
  const decimal = opts.decimal === ',' ? ',' : '.';
  // A comma decimal mark inside comma-separated fields is unparseable ("1,5" reads as two cells) even
  // with quoting, since most importers strip quotes before sniffing numbers. Refuse rather than emit a
  // file that silently corrupts every amount.
  if (decimal === ',' && delimiter === ',') {
    throw new Error('csv: decimal "," cannot be used with delimiter "," — pick ";" as the delimiter');
  }
  const eol = opts.eol || '\r\n';
  const columns = opts.columns || columnsOf(rows);
  const line = (cells) => cells.map((c) => csvEscape(c, delimiter, decimal)).join(delimiter);
  const out = [];
  if (opts.header !== false && columns) out.push(line(columns));
  for (const row of rows || []) {
    out.push(Array.isArray(row) ? line(row) : line(columns.map((c) => row[c])));
  }
  return (opts.bom === false ? '' : BOM) + out.join(eol) + (out.length ? eol : '');
}

// Union of the keys present in the rows, in first-appearance order (stable for a given input).
function columnsOf(rows) {
  if (!rows || !rows.length || Array.isArray(rows[0])) return null;
  const cols = [];
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r || {})) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  return cols;
}

// --- Projection: normalized record → spreadsheet row -------------------------------------------------
//
// The fixed columns are the fields every consumer of a finance export expects, and their headers are
// deliberately NOT translated: they are a machine contract (another app's importer reads them), unlike the
// button that produces the file, which is i18n'd like the rest of the UI.
export const CSV_COLUMNS = ['date', 'description', 'amount', 'currency', 'balance', 'account', 'category', 'source', 'id'];

// Which record field feeds each fixed column, most-specific first. Taken from what buildRecord actually
// emits per schema (receipt@1 / invoice@1 / transaction@1 / investment@1|@2), not invented:
//  - money: `total` (receipt/invoice), `amount` (transaction, investment@1, investment@2 cash),
//    `netAmount`/`grossAmount` (investment@2 trade).
//  - balance: only `balanceAfter` (transaction@1, the running balance a bank movement carries).
//  - account: `account` (transaction@1), `settlementAccount` (investment@2 trade), `group` (the
//    account/card label a grouped source stamps on every row).
const AMOUNT_KEYS = ['total', 'amount', 'netAmount', 'grossAmount'];
const ACCOUNT_KEYS = ['account', 'settlementAccount', 'group'];

// The first key of `keys` the record actually carries — returned as [key, value] so the caller can mark
// exactly that key as consumed and leave its siblings (e.g. grossAmount next to netAmount) as own columns.
function pick(record, keys) {
  for (const k of keys) { const v = record[k]; if (v != null && v !== '') return [k, v]; }
  return [null, ''];
}

// Flatten nested values into dotted paths (`store.name`, `instrument.ticker`, `extra.concept`), so every
// captured field lands in its own column instead of a JSON blob. Arrays are left to csvEscape (JSON), since
// their length varies per row and would make the header unstable.
function flattenInto(out, value, prefix, depth = 0) {
  if (value == null || value === '') return;
  if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && depth < 4) {
    for (const [k, v] of Object.entries(value)) flattenInto(out, v, prefix ? prefix + '.' + k : k, depth + 1);
    return;
  }
  out[prefix] = value;
}

// One record → one row object. Fixed columns first, then EVERY remaining field of the record (including
// `record.extra`, which flattens to `extra.<field>` because it is a nested object) — the store's promise is
// that nothing captured is lost, and an export that quietly dropped fields would break it.
export function recordToRow(record) {
  const r = record || {};
  const [amountKey, amount] = pick(r, AMOUNT_KEYS);
  const [accountKey, account] = pick(r, ACCOUNT_KEYS);
  const consumed = new Set(['internalId', 'date', 'currency', 'category', 'source', 'balanceAfter', 'description']);
  if (amountKey) consumed.add(amountKey);
  if (accountKey) consumed.add(accountKey);
  const row = {
    date: r.date == null ? '' : String(r.date),
    // The free-text concept when the source has one, else the human name of the counterparty/store/issuer/
    // instrument (recdisplay.js — the same chain every listing UI already shows).
    description: r.description || displayName(r) || '',
    amount,
    currency: r.currency || '',
    balance: r.balanceAfter == null ? '' : r.balanceAfter,
    account: account == null ? '' : account,
    category: r.category || '',
    source: r.source || '',
    id: r.internalId == null ? '' : String(r.internalId),
  };
  const rest = {};
  for (const [k, v] of Object.entries(r)) if (!consumed.has(k)) flattenInto(rest, v, k);
  return { ...row, ...rest };
}

// Records → rows, with the fixed columns first and the per-source extras appended in first-appearance order.
export function recordsToRows(records) {
  return (records || []).map(recordToRow);
}

// Columns for a set of rows: the fixed contract first, then whatever extra fields showed up.
export function csvColumns(rows) {
  const cols = [...CSV_COLUMNS];
  const seen = new Set(cols);
  for (const row of rows || []) for (const k of Object.keys(row)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  return cols;
}

// The whole projection in one call: normalized records → CSV text. opts are toCsv's ({ delimiter, bom, eol }).
export function recordsToCsv(records, opts = {}) {
  const rows = recordsToRows(records);
  return toCsv(rows, { ...opts, columns: opts.columns || csvColumns(rows) });
}

// A store source ({ meta, items }) → its live records, newest first. Tombstoned items (`gone`) are left out
// by default: they are things the source no longer has, kept only so an enumeration glitch can't resurrect
// them as "new" — exporting them as if they still existed would be a lie. { includeGone: true } opts in.
export function storeSourceRecords(sourceData, { includeGone = false } = {}) {
  const items = (sourceData && sourceData.items) || {};
  const out = [];
  for (const [id, e] of Object.entries(items)) {
    if (!e || (e.gone && !includeGone)) continue;
    // The id lives only as the map KEY in the portable format (cleanEntry drops it from the value).
    out.push({ internalId: id, ...(e.record || {}) });
  }
  return out.sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : (a.date || '') > (b.date || '') ? -1 : 0));
}

// habeas-<source>-YYYY-MM-DD.csv — the source id can carry a stream suffix ("ing-es:movements") and, on a
// community source, anything its author typed, so it is reduced to filename-safe characters.
export function csvFileName(sourceId, date) {
  const day = (date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const safe = String(sourceId || 'store').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'store';
  return `habeas-${safe}-${day}.csv`;
}
