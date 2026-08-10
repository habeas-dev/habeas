// CSV projection of the canonical store (lib/csv.js): RFC 4180 quoting, the UTF-8 BOM Excel needs,
// both separators, and the promise that nothing captured is lost (record.extra → extra.* columns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOM, csvEscape, toCsv, recordsToCsv, recordToRow, storeSourceRecords, csvFileName } from '../src/lib/csv.js';

const body = (csv) => csv.replace(BOM, '').trimEnd().split('\r\n');

test('csvEscape: quotes only what RFC 4180 requires, doubling inner quotes', () => {
  assert.equal(csvEscape('plain', ';'), 'plain');
  assert.equal(csvEscape('has;separator', ';'), '"has;separator"');
  assert.equal(csvEscape('has;separator', ','), 'has;separator');   // not the active separator → no quoting
  assert.equal(csvEscape('has,comma', ','), '"has,comma"');
  assert.equal(csvEscape('say "hi"', ';'), '"say ""hi"""');
  assert.equal(csvEscape('line1\nline2', ';'), '"line1\nline2"');
  assert.equal(csvEscape('cr\r\nlf', ';'), '"cr\r\nlf"');
  assert.equal(csvEscape(null, ';'), '');
  assert.equal(csvEscape(undefined, ';'), '');
  assert.equal(csvEscape(0, ';'), '0');            // a real zero is not blank
  assert.equal(csvEscape(-12.5, ';'), '-12.5');
  assert.equal(csvEscape(false, ';'), 'false');
  assert.equal(csvEscape({ a: 1 }, ';'), '"{""a"":1}"'); // an unflattened value is readable, not [object Object]
});

test('toCsv: BOM by default (Excel opens accents correctly), optional, CRLF rows', () => {
  const csv = toCsv([{ a: 'á', b: 1 }]);
  assert.ok(csv.startsWith(BOM), 'must start with the UTF-8 BOM');
  assert.equal(csv, BOM + 'a;b\r\ná;1\r\n');
  assert.equal(toCsv([{ a: 'á' }], { bom: false }), 'a\r\ná\r\n');
  assert.ok(!toCsv([{ a: 1 }], { bom: false }).includes(BOM));
});

test('toCsv: both separators, and a value containing the OTHER one is left unquoted', () => {
  const rows = [{ concept: 'CAFE; BAR', amount: -3.5 }];
  assert.equal(toCsv(rows, { bom: false }), 'concept;amount\r\n"CAFE; BAR";-3.5\r\n');
  assert.equal(toCsv(rows, { bom: false, delimiter: ',' }), 'concept,amount\r\nCAFE; BAR,-3.5\r\n');
});

test('toCsv: explicit columns, missing keys become empty cells; header can be dropped', () => {
  const csv = toCsv([{ a: 1 }, { b: 2 }], { bom: false, columns: ['a', 'b'] });
  assert.deepEqual(csv.trimEnd().split('\r\n'), ['a;b', '1;', ';2']);
  assert.equal(toCsv([{ a: 1 }], { bom: false, header: false }), '1\r\n');
  assert.equal(toCsv([], { bom: false }), ''); // nothing at all → no stray newline
});

test('recordToRow: transaction@1 fills the fixed columns from the fields buildRecord emits', () => {
  const row = recordToRow({
    internalId: 'tx1', date: '2026-07-01', amount: -42.5, currency: 'EUR', category: 'grocery',
    description: 'COMPRA CARREFOUR', counterparty: 'Carrefour', direction: 'debit', source: 'ing-es',
    type: 'purchase', account: 'ES12 **** 1234', balanceAfter: 1200.25,
  });
  assert.equal(row.date, '2026-07-01');
  assert.equal(row.description, 'COMPRA CARREFOUR');
  assert.equal(row.amount, -42.5);
  assert.equal(row.currency, 'EUR');
  assert.equal(row.balance, 1200.25);
  assert.equal(row.account, 'ES12 **** 1234');
  assert.equal(row.category, 'grocery');
  assert.equal(row.source, 'ing-es');
  assert.equal(row.id, 'tx1');
  // fields outside the fixed contract survive as their own columns
  assert.equal(row.counterparty, 'Carrefour');
  assert.equal(row.direction, 'debit');
  assert.equal(row.type, 'purchase');
});

test('recordToRow: receipt@1/invoice@1 total → amount, nested store/issuer flatten, name fills description', () => {
  const receipt = recordToRow({ internalId: 'r1', date: '2026-02-03', total: 18.9, currency: 'EUR', category: 'grocery', store: { name: 'Dia', address: 'C/ Mayor 1' }, source: 'dia-es', type: 'ticket' });
  assert.equal(receipt.amount, 18.9);
  assert.equal(receipt.description, 'Dia');            // no free-text concept → the store name
  assert.equal(receipt['store.name'], 'Dia');          // …and nothing is lost
  assert.equal(receipt['store.address'], 'C/ Mayor 1');
  const invoice = recordToRow({ internalId: 'i1', date: '2026-02-03', total: 30, currency: 'EUR', issuer: { name: 'Hover', address: '' }, number: 'F-2026-1', source: 'hover' });
  assert.equal(invoice.description, 'Hover');
  assert.equal(invoice.number, 'F-2026-1');
});

test('recordToRow: investment@2 trade uses netAmount, keeps grossAmount, account from settlementAccount', () => {
  const row = recordToRow({
    internalId: 'op1', recordType: 'trade', date: '2026-05-05', side: 'buy', currency: 'EUR',
    units: 3, price: 100, grossAmount: 300, commission: 1, netAmount: 301,
    settlementAccount: 'DE00 **** 9999', instrument: { isin: 'IE00B4L5Y983', ticker: 'IWDA', name: 'iShares Core MSCI World' }, source: 'trade-republic',
  });
  assert.equal(row.amount, 301);           // the settled money
  assert.equal(row.grossAmount, 300);      // the sibling stays its own column
  assert.equal(row.account, 'DE00 **** 9999');
  assert.equal(row.description, 'iShares Core MSCI World');
  assert.equal(row['instrument.ticker'], 'IWDA');
  assert.equal(row['instrument.isin'], 'IE00B4L5Y983');
});

test('recordsToCsv: fixed English headers first, extra.* appended at the end, values quoted', () => {
  const csv = recordsToCsv([
    {
      internalId: 'a1', date: '2026-07-01', amount: -10, currency: 'EUR', category: 'fuel',
      description: 'GASOLINERA "EL PINO"; km 4', source: 'wizink', account: 'Oro 8765',
      extra: { concept: 'PAGO EN COMERCIO', reference: 'REF;1', moreInfo: 'línea1\nlínea2' },
    },
  ]);
  const [header, row] = body(csv);
  assert.equal(header.split(';').slice(0, 9).join(';'), 'date;description;amount;currency;balance;account;category;source;id');
  assert.ok(header.endsWith('extra.concept;extra.reference;extra.moreInfo'), header);
  assert.ok(row.includes('"GASOLINERA ""EL PINO""; km 4"'));
  assert.ok(row.includes('"REF;1"'));
  assert.ok(row.includes('"línea1\nlínea2"'));
  assert.ok(csv.startsWith(BOM));
});

test('recordsToCsv: heterogeneous records share one header; every extra column is a union', () => {
  const csv = recordsToCsv([
    { internalId: 'a', date: '2026-01-02', total: 5, currency: 'EUR', extra: { ticketNo: 7 } },
    { internalId: 'b', date: '2026-01-03', amount: 9, currency: 'USD', extra: { orderId: 'X9' } },
  ], { delimiter: ',', bom: false });
  const [header, r1, r2] = body(csv);
  assert.ok(header.endsWith('extra.ticketNo,extra.orderId'), header);
  assert.equal(r1.split(',').pop(), '');     // record a has no orderId
  assert.equal(r2.split(',').pop(), 'X9');
  assert.equal(r1.split(',')[0], '2026-01-02');
});

test('storeSourceRecords: skips tombstones (opt-in), reads the id from the map KEY, newest first', () => {
  const src = {
    meta: { source: 'ing-es' },
    items: {
      old: { record: { date: '2026-01-01', amount: 1 }, at: 't' },
      recent: { record: { date: '2026-06-01', amount: 2 }, at: 't' },
      dead: { record: { date: '2026-07-01', amount: 3 }, gone: true, goneReason: 'retention', at: 't' },
    },
  };
  assert.deepEqual(storeSourceRecords(src).map((r) => r.internalId), ['recent', 'old']);
  assert.deepEqual(storeSourceRecords(src, { includeGone: true }).map((r) => r.internalId), ['dead', 'recent', 'old']);
  assert.deepEqual(storeSourceRecords(null).map((r) => r.internalId), []);
  // the id ends up in the `id` column even though the portable format keeps it only as the key
  assert.equal(recordsToCsv(storeSourceRecords(src), { bom: false }).split('\r\n')[1].split(';')[8], 'recent');
});

test('csvFileName: habeas-<source>-<day>.csv, with the stream suffix made filename-safe', () => {
  assert.equal(csvFileName('ing-es', '2026-08-11'), 'habeas-ing-es-2026-08-11.csv');
  assert.equal(csvFileName('ing-es:movements', '2026-08-11'), 'habeas-ing-es-movements-2026-08-11.csv');
  assert.equal(csvFileName('', '2026-08-11'), 'habeas-store-2026-08-11.csv');
  assert.match(csvFileName('all'), /^habeas-all-\d{4}-\d{2}-\d{2}\.csv$/); // defaults to today
});

// ── decimal mark ────────────────────────────────────────────────────────────
// Two audiences want opposite things: another APP re-importing the file needs a dot (a locale-dependent
// decimal inside a machine contract is a bug), while a PERSON opening it in a comma-locale spreadsheet
// needs a comma or every amount lands as text.
test('decimal: "," renders numbers with a comma, leaving strings alone', () => {
  const csv = toCsv([{ amount: -12.5, note: 'a.b', n: 1000 }], { decimal: ',', bom: false, header: false });
  assert.equal(csv.trim(), '-12,5;a.b;1000');
});

test('decimal: defaults to "." and ignores non-finite numbers', () => {
  assert.equal(toCsv([{ a: -12.5 }], { bom: false, header: false }).trim(), '-12.5');
  assert.equal(toCsv([{ a: NaN }], { decimal: ',', bom: false, header: false }).trim(), 'NaN');
  assert.equal(toCsv([{ a: Infinity }], { decimal: ',', bom: false, header: false }).trim(), 'Infinity');
});

test('decimal: a comma decimal with a comma delimiter is refused, not silently corrupted', () => {
  assert.throws(() => toCsv([{ a: 1.5 }], { decimal: ',', delimiter: ',' }), /delimiter/);
});

test('decimal: comma values still get quoted when the delimiter is ";"… they do not need to be', () => {
  // "1234,5" contains no ';', no quote and no newline → no quoting required by RFC 4180.
  assert.equal(toCsv([{ a: 1234.5 }], { decimal: ',', bom: false, header: false }).trim(), '1234,5');
});
