// invoice@2 — a RECEIVED invoice from a service with no API (first: Stripe's monthly fee invoices, which exist
// only as PDFs in the dashboard). Agreed with Cuéntamo: `_schema` on every record, `flow` fixed to "received",
// the issuer as a structured party, the billed period with an INCLUSIVE end, the recipient's tax id so the
// consumer can check the invoice belongs to the book's owner, and the account the invoice came from.
// Amounts are optional: Stripe's list carries none (the consumer reads them from the PDF), and they must be
// ABSENT then — never zero, never an invented EUR.
//
// Every value below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord } from '../src/sinks/format.js';

const ADP = { id: 'demo-fees', schema: 'invoice@2', fields: {} };
const day = (iso) => Date.parse(iso + 'T00:00:00Z') / 1000;

const base = {
  internalId: 'vati_EXAMPLE0001', number: 'ABCD1234-2026-09', date: '2026-10-05',
  periodStart: day('2026-09-01'), periodEnd: day('2026-10-01'),
  reverseCharge: false, corrected: false,
  recipientTaxId: 'ESX0000000X',
  issuerName: 'Demo Payments Ltd', issuerTaxId: 'IE0000000X', issuerCountry: 'IE',
  _group: { id: 'acct_000EXAMPLE', label: 'Demo account' },
  source: 'demo-fees', type: 'fee_invoice', category: 'fees',
};

test('invoice@2 received: schema tag, flow, number, issue date, issuer and recipient tax id', () => {
  const r = buildRecord(base, ADP);
  assert.equal(r._schema, 'invoice@2');
  assert.equal(r.flow, 'received');
  assert.equal(r.internalId, 'vati_EXAMPLE0001');
  assert.equal(r.number, 'ABCD1234-2026-09');
  assert.equal(r.issueDate, '2026-10-05');
  assert.equal(r.date, '2026-10-05'); // kept for Habeas's own store/ledger/viewer, which key on `date`
  assert.deepEqual(r.issuer, { name: 'Demo Payments Ltd', taxId: 'IE0000000X', country: 'IE' });
  assert.equal(r.recipientTaxId, 'ESX0000000X');
  assert.equal(r.reverseCharge, false);
  assert.equal(r.corrected, false);
  assert.deepEqual(r.account, { id: 'acct_000EXAMPLE', label: 'Demo account' });
  assert.equal(r.source, 'demo-fees');
});

test('invoice@2: no amounts in the source → no amount, currency or taxes keys at all', () => {
  const r = buildRecord(base, ADP);
  for (const k of ['total', 'subtotal', 'currency', 'taxes', 'exchangeRate', 'operationDate']) assert.ok(!(k in r), k + ' must be absent');
});

test('invoice@2: service period end is inclusive — an exclusive first-of-next-month end loses a day', () => {
  const r = buildRecord(base, ADP);
  assert.deepEqual(r.servicePeriod, { start: '2026-09-01', end: '2026-09-30' });
});

test('invoice@2: a period end that already is the last billed day is kept as is', () => {
  const r = buildRecord({ ...base, periodEnd: Date.parse('2026-09-30T23:59:59Z') / 1000 }, ADP);
  assert.deepEqual(r.servicePeriod, { start: '2026-09-01', end: '2026-09-30' });
});

test('invoice@2: period dates as ISO strings work too, and a lone start is not invented into a range', () => {
  assert.deepEqual(buildRecord({ ...base, periodStart: '2026-09-01', periodEnd: '2026-10-01' }, ADP).servicePeriod, { start: '2026-09-01', end: '2026-09-30' });
  assert.ok(!('servicePeriod' in buildRecord({ ...base, periodEnd: undefined }, ADP)));
  // A last-day date written without a time is NOT an exclusive bound.
  assert.deepEqual(buildRecord({ ...base, periodStart: '2026-09-01', periodEnd: '2026-09-30' }, ADP).servicePeriod, { start: '2026-09-01', end: '2026-09-30' });
});

test('invoice@2: amounts and taxes when a source has them; a credit note keeps its negative sign', () => {
  const taxes = [{ kind: 'vat', rate: 21, base: -100, amount: -21, supplyType: 'services' }];
  const r = buildRecord({ ...base, currency: 'EUR', subtotal: '-100,00', total: '-121,00', taxes, operationDate: '2026-09-30', correctsNumber: 'ABCD1234-2026-08', correctsDate: '2026-09-05' }, ADP);
  assert.equal(r.currency, 'EUR');
  assert.equal(r.subtotal, -100);
  assert.equal(r.total, -121);
  assert.deepEqual(r.taxes, taxes);
  assert.equal(r.operationDate, '2026-09-30');
  assert.equal(r.correctsNumber, 'ABCD1234-2026-08');
  assert.equal(r.correctsDate, '2026-09-05');
});

test('invoice@2: anything else the source maps rides in extra (e.g. Stripe\'s `credited`)', () => {
  const r = buildRecord({ ...base, credited: { id: 'cn_EXAMPLE' } }, { ...ADP, fields: { credited: 'credited' } });
  assert.deepEqual(r.extra, { credited: { id: 'cn_EXAMPLE' } });
});

test('invoice@2: an account mapped as fields (no group) still lands in account {id,label}', () => {
  const r = buildRecord({ ...base, _group: undefined, accountId: 'acct_000OTHER', accountLabel: 'Other' }, ADP);
  assert.deepEqual(r.account, { id: 'acct_000OTHER', label: 'Other' });
});

test('invoice@1 is untouched by the new schema', () => {
  const r = buildRecord({ internalId: 'X1', date: '2026-01-01', total: 10, issuer: 'Shop' }, { schema: 'invoice@1' });
  assert.ok(!('_schema' in r) && !('flow' in r));
  assert.deepEqual(r.issuer, { name: 'Shop', address: '' });
});

test('invoice@2 survives a sink that asks for the canonical shape: a self-describing record passes through', async () => {
  const { canonicalize } = await import('../src/lib/normalize.js');
  const r = buildRecord(base, ADP);
  assert.deepEqual(canonicalize(r), r);
});
