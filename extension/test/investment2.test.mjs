// investment@2 (broker trade/cash) + bank canonical enrichment (structured account, valueDate/balanceAfter)
// for the Cuéntamo data contract. All values here are SYNTHETIC — never a real capture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord } from '../src/sinks/format.js';
import { canonicalize } from '../src/lib/normalize.js';

const BROKER = { schema: 'investment@2', currency: 'EUR', id: 'demo-broker', service: 'demo' };

test('investment@2 trade: structured instrument + settlement breakdown, side enum normalized', () => {
  const r = buildRecord({
    internalId: 'T1', date: '2026-02-03', recordType: 'trade', side: 'BUY',
    isin: 'XX0000000001', ticker: 'DEMO', mic: 'XMAD', instrumentName: 'Demo Index ETF', assetClass: 'etf',
    units: '10', price: '25,50', grossAmount: '255,00', commission: '1,20', taxWithheld: '0', netAmount: '256,20',
    exchangeRate: '1', settlementAccount: 'ES0000000000000000000000',
  }, BROKER);
  assert.equal(r.recordType, 'trade');
  assert.equal(r.side, 'buy'); // enum-normalized (upper → lower)
  assert.deepEqual(r.instrument, { isin: 'XX0000000001', ticker: 'DEMO', mic: 'XMAD', name: 'Demo Index ETF', assetClass: 'etf' });
  assert.equal(r.units, 10);
  assert.equal(r.price, 25.5);
  assert.equal(r.grossAmount, 255);
  assert.equal(r.commission, 1.2);
  assert.equal(r.taxWithheld, 0); // a zero is kept (present ≠ empty)
  assert.equal(r.netAmount, 256.2);
  assert.equal(r.currency, 'EUR');
  assert.equal(r.settlementAccount, 'ES0000000000000000000000');
});

test('investment@2 trade: inferred when no recordType but an instrument/units are present', () => {
  const r = buildRecord({ internalId: 'T2', date: '2026-02-04', isin: 'XX0000000002', units: 3, price: 10, amount: 30, operation: 'sell' }, BROKER);
  assert.equal(r.recordType, 'trade');
  assert.equal(r.side, 'sell'); // taken from `operation`
  assert.equal(r.netAmount, 30); // falls back to amount when no explicit netAmount
  assert.equal(r.instrument.isin, 'XX0000000002');
});

test('investment@2 cash: kind enum, direction from sign, no instrument', () => {
  const r = buildRecord({ internalId: 'C1', date: '2026-02-05', recordType: 'cash', kind: 'Interest', amount: '4,20', description: 'Cash interest', account: 'ES0000000000000000000001' }, BROKER);
  assert.equal(r.recordType, 'cash');
  assert.equal(r.kind, 'interest');
  assert.equal(r.amount, 4.2);
  assert.equal(r.direction, 'credit');
  assert.equal(r.description, 'Cash interest');
  assert.equal(r.account, 'ES0000000000000000000001');
  assert.ok(!('instrument' in r), 'cash rows carry no instrument');
});

test('investment@2 cash: inferred when no instrument/units, negative amount → debit', () => {
  const r = buildRecord({ internalId: 'C2', date: '2026-02-06', type: 'withdrawal', amount: -50 }, BROKER);
  assert.equal(r.recordType, 'cash');
  assert.equal(r.kind, 'withdrawal');
  assert.equal(r.direction, 'debit');
});

test('investment@2 keeps an unrecognized side/kind verbatim (nothing silently dropped)', () => {
  const trade = buildRecord({ internalId: 'T3', date: '2026-02-07', recordType: 'trade', side: 'odd_lot', isin: 'XX0000000003' }, BROKER);
  assert.equal(trade.side, 'odd_lot');
  const cash = buildRecord({ internalId: 'C3', date: '2026-02-08', recordType: 'cash', kind: 'rebate', amount: 1 }, BROKER);
  assert.equal(cash.kind, 'rebate');
});

test('investment@1 keeps its historical flat shape (no recordType)', () => {
  const r = buildRecord({ internalId: 'I1', date: '2026-02-09', instrument: 'Demo Fund', isin: 'XX0000000004', units: 2, price: 5, amount: 10, operation: 'buy' }, { schema: 'investment@1', currency: 'EUR' });
  assert.ok(!('recordType' in r));
  assert.equal(r.instrument, 'Demo Fund');
  assert.equal(r.operation, 'buy');
});

test('bank transaction@1 promotes account / valueDate / balanceAfter only when present', () => {
  const enriched = buildRecord({ internalId: 'M1', date: '2026-03-01', amount: -12.5, account: 'ES9121000418450200051332', valueDate: '2026-03-02', balanceAfter: '1.234,56' }, { schema: 'transaction@1', currency: 'EUR' });
  assert.equal(enriched.account, 'ES9121000418450200051332');
  assert.equal(enriched.valueDate, '2026-03-02');
  assert.equal(enriched.balanceAfter, 1234.56);
  const plain = buildRecord({ internalId: 'M2', date: '2026-03-03', amount: -1 }, { schema: 'transaction@1', currency: 'EUR' });
  assert.ok(!('account' in plain) && !('valueDate' in plain) && !('balanceAfter' in plain), 'byte-identical when absent');
});

test('canonicalize builds a structured account { iban, last4, currency } for a bank movement', () => {
  const c = canonicalize({ internalId: 'M1', date: '2026-03-01', amount: -12.5, currency: 'EUR', account: 'ES9121000418450200051332', group: 'ACC-1', valueDate: '2026-03-02', balanceAfter: 1234.56, source: 'demo-bank' });
  assert.deepEqual(c.account, { iban: 'ES9121000418450200051332', last4: '1332', groupId: 'ACC-1', currency: 'EUR' });
  assert.equal(c.valueDate, '2026-03-02');
  assert.equal(c.balanceAfter, 1234.56);
  assert.equal(c.direction, 'debit');
});

test('canonicalize derives last4 from a masked PAN (card source)', () => {
  const c = canonicalize({ internalId: 'C1', date: '2026-03-01', amount: 9, currency: 'EUR', account: '**** **** **** 0000', source: 'demo-card' });
  assert.deepEqual(c.account, { last4: '0000', currency: 'EUR' });
});

test('canonicalize passes through an already-structured account object untouched', () => {
  const acc = { iban: 'ES0000000000000000000000', last4: '0000', currency: 'USD' };
  const c = canonicalize({ internalId: 'x', date: '2026-03-01', amount: 1, currency: 'EUR', account: acc, source: 's' });
  assert.deepEqual(c.account, acc);
});

test('canonicalize keeps the historical string account when nothing structured can be derived', () => {
  const c = canonicalize({ internalId: 'x', date: '2026-03-01', amount: 1, currency: 'EUR', group: 'GRP-9', source: 's' });
  assert.deepEqual(c.account, { groupId: 'GRP-9', currency: 'EUR' });
  const none = canonicalize({ internalId: 'x', date: '2026-03-01', total: 5, currency: 'EUR', source: 's' });
  assert.equal(none.account, ''); // receipt with no account/group → empty string, as before
});

// Grouped bank/card sources: the canonical account.last4 must be the number the user recognizes (the card's
// last four from the group label), never the last 4 of an opaque internal account id. Shapes mirror the real
// adapters (WiZink account = internal id; FECI = group only; Openbank = real account number). Values synthetic.
test('canonicalize grouped card: last4 comes from the group label, not the opaque account id (WiZink-shape)', () => {
  const c = canonicalize({ internalId: 'x', date: '2026-03-01', amount: -9, currency: 'EUR', account: '0090000123', group: 'Demo Oro 8765', source: 'wizink-es' });
  assert.equal(c.account.last4, '8765'); // the card last4 from the label, NOT '0123' from the internal id
  assert.equal(c.account.groupId, 'Demo Oro 8765');
});

test('canonicalize grouped card: last4 from the group label when no account is mapped (FECI-shape)', () => {
  const c = canonicalize({ internalId: 'x', date: '2026-03-01', amount: -9, currency: 'EUR', group: 'ECI Visa 4321', source: 'financiera-elcorteingles-es' });
  assert.deepEqual(c.account, { last4: '4321', groupId: 'ECI Visa 4321', currency: 'EUR' });
});

test('canonicalize grouped bank: last4 from a real account number when the label has none (Openbank-shape)', () => {
  const c = canonicalize({ internalId: 'x', date: '2026-03-01', amount: -9, currency: 'EUR', account: '0001234567', group: 'Cuenta Corriente', source: 'openbank-es' });
  assert.equal(c.account.last4, '4567'); // the account number's own last 4 (label carries no trailing digits)
  assert.equal(c.account.groupId, 'Cuenta Corriente');
});

test('canonicalize currency wallet: groupId only, no last4 (Revolut-shape pocket)', () => {
  const c = canonicalize({ internalId: 'x', date: '2026-03-01', amount: -9, currency: 'USD', group: 'USD', source: 'revolut' });
  assert.deepEqual(c.account, { groupId: 'USD', currency: 'USD' });
  assert.ok(!('last4' in c.account));
});

test('canonicalize of an investment@2 trade uses netAmount for amount and instrument name as counterparty', () => {
  const rec = buildRecord({ internalId: 'T1', date: '2026-02-03', recordType: 'trade', side: 'buy', isin: 'XX0000000001', instrumentName: 'Demo Index ETF', units: 10, price: 25.5, netAmount: 256.2 }, BROKER);
  const c = canonicalize(rec);
  assert.equal(c.amount, 256.2);
  assert.equal(c.counterparty, 'Demo Index ETF');
});
