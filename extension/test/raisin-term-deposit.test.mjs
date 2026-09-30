// Raisin's fixed-term deposits reach Cuéntamo as investment@2 `cash` records. Without a declared `kind` the
// record looked like a plain cash movement carrying the deposit's balance, and the consumer booked it as
// income. The source now DECLARES what the record is (kind: term_deposit) and carries its terms: the
// principal, the nominal rate, the term and the maturity date.
//
// The payload below is shaped like /dbff/v1/public/deposits/dashboard/{active,inactive}, but every value is
// invented. Nothing here comes from a real capture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory } from '../src/runtime/inventory.js';
import { resolveOutput } from '../src/lib/outputs.js';
import { buildRecord } from '../src/sinks/format.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const RAISIN = JSON.parse(readFileSync(join(ROOT, 'sources-repo/sources/raisin.json'), 'utf8'));
const ADP = resolveOutput(RAISIN, 'depositos');
const AUTH = { merged: {}, byPath: {}, ctx: { customer_id: 'BAC_000_000_000_001' } };
const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });

const entry = (id, { state, balance, principal, rate, eff, months, open, maturity }) => ({
  deposit: { id, customer_id: 'BAC_000_000_000_001', deposit_state: state, opening_date: open, maturity_date: maturity, opening_order_amount: Number(principal) },
  product: { term: { unit: 'months', period: months }, term_normalized: { months }, deposit_taking_bank: { name: 'Demo Bank' } },
  accounting: {
    deposit_id: id, customer_id: 'BAC_000_000_000_001', term: { period: 'MONTH', units: months }, opening_date: open,
    balance: { amount: { currency: 'EUR', denomination: balance } },
    initial_investment: { currency: 'EUR', denomination: principal },
    interest_rate: rate, effective_interest_rate: eff,
  },
});
// An open deposit whose balance already equals the principal, and a matured one whose balance is back to
// zero — the case where "amount = balance" reported a 0 € deposit.
const OPEN = entry('FDA_000_000_000_001', { state: 'OPENED', balance: '15000.00', principal: '15000.00', rate: '2.6500', eff: '2.6800', months: 12, open: '2026-01-10', maturity: '2027-01-11' });
const DONE = entry('FDA_000_000_000_002', { state: 'MATURED', balance: '0.00', principal: '8000.00', rate: '2.1000', eff: '2.1200', months: 6, open: '2025-02-03', maturity: '2025-08-04' });
const SAVINGS = entry('OMA_000_000_000_003', { state: 'OPENED', balance: '500.00', principal: '0.00', rate: '1.0000', eff: '1.0000', months: 0, open: '2024-05-05' });
const feed = async (url) => ok({ entries: String(url).includes('inactive') ? [DONE] : [OPEN, SAVINGS] });

const records = async () => {
  const docs = await listInventory(ADP, AUTH, feed, {});
  return Object.fromEntries(docs.map((d) => [d.internalId, buildRecord(d, ADP)]));
};

test('a Raisin fixed-term deposit is declared as a term deposit, not an anonymous cash movement', async () => {
  const r = (await records()).FDA_000_000_000_001;
  assert.equal(r.recordType, 'cash');
  assert.equal(r.kind, 'term_deposit');
  assert.equal(r.date, '2026-01-10');
  assert.equal(r.currency, 'EUR');
  assert.equal(r.counterparty, 'Demo Bank');
});

test('it carries the terms Cuéntamo would otherwise have to parse out of the description', async () => {
  const r = (await records()).FDA_000_000_000_001;
  assert.equal(r.interestRate, 2.65, 'the NOMINAL rate, as a percentage');
  assert.equal(r.rateKind, 'tin');
  assert.equal(r.termMonths, 12);
  assert.equal(r.maturityDate, '2027-01-11');
  assert.equal(r.account, 'BAC_000_000_000_001');
  for (const k of ['interestRate', 'rateKind', 'termMonths', 'maturityDate', 'kind'])
    assert.ok(!(r.extra && k in r.extra), `${k} is a first-class field, not buried in extra`);
});

test('the amount is the principal invested, not what the deposit holds today', async () => {
  const r = (await records()).FDA_000_000_000_002;
  assert.equal(r.amount, 8000, 'a matured deposit has a zero balance but was still an 8000 deposit');
  assert.equal(r.direction, 'credit');
  assert.equal(r.maturityDate, '2025-08-04');
});

test('savings accounts stay out of the deposits stream', async () => {
  const recs = await records();
  assert.deepEqual(Object.keys(recs).sort(), ['FDA_000_000_000_001', 'FDA_000_000_000_002']);
});

test('a field can be a constant: { const } yields the value itself, not a path into the item', async () => {
  const adapter = { id: 'x', schema: 'receipt@1', api: { host: 'https://h.example', list: { path: '/l', paging: 'none', itemsPath: 'items' } }, fields: { internalId: 'id', date: 'd', kind: { const: 'id' } } };
  const net = async () => ok({ items: [{ id: 'A-1', d: '2026-01-01' }] });
  const [doc] = await listInventory(adapter, { byPath: {}, merged: {} }, net, {});
  assert.equal(doc.kind, 'id', 'the literal, even when it happens to name a field of the item');
});

test('investment@2 cash without deposit terms keeps its exact historical shape', () => {
  const r = buildRecord({ internalId: 'C9', date: '2026-02-05', recordType: 'cash', kind: 'interest', amount: 3 }, { schema: 'investment@2', currency: 'EUR' });
  assert.deepEqual(Object.keys(r).sort(), ['amount', 'currency', 'date', 'direction', 'internalId', 'kind', 'recordType']);
});

test('a deposit already in the store is re-normalized with its kind and terms (from its kept raw fields)', async () => {
  const { renormalizeRecord } = await import('../src/lib/migrate.js');
  const stored = { internalId: 'FDA_000_000_000_001', recordType: 'cash', date: '2026-01-10', amount: 15000, currency: 'EUR', direction: 'credit', counterparty: 'Demo Bank', category: 'investment', extra: { deposit: OPEN.deposit, product: OPEN.product, accounting: OPEN.accounting } };
  const { record, changed } = renormalizeRecord(stored, ADP);
  assert.ok(changed);
  assert.equal(record.kind, 'term_deposit');
  assert.equal(record.interestRate, 2.65);
  assert.equal(record.rateKind, 'tin');
  assert.equal(record.termMonths, 12);
  assert.equal(record.maturityDate, '2027-01-11');
});
