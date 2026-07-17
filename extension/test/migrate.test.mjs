// Offline re-normalization of already-stored records to the current schema (bank balanceAfter/valueDate;
// Trade Republic transaction@1 -> investment@2). All values SYNTHETIC — never a real capture. The store-level
// walk (renormalizeStore / ledger reset) is covered via an in-memory backend + config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renormalizeRecord, needsMigration, renormalizeStore, resetReadWriteLedgers, RW_SINK_TYPES } from '../src/lib/migrate.js';

// --- effective adapters mirroring the real ones' relevant fields (synthetic) ---
const TR = {
  id: 'traderepublic', service: 'traderepublic', schema: 'investment@2', keepRaw: true, categories: ['banking', 'investment'],
  normalize: {
    fields: { isin: { from: 'icon', re: ['^logos/([A-Z]{2}[A-Z0-9]{9}[0-9])/'] } },
    map: {
      side: { from: 'type', map: { TRADING_SAVINGSPLAN_EXECUTED: 'buy' } },
      kind: { from: 'type', map: { INTEREST_PAYOUT: 'interest', BANK_TRANSACTION_INCOMING: 'deposit' } },
    },
  },
  fields: { internalId: 'id', date: 'timestamp', amount: 'amount.value', currency: 'amount.currency', description: 'title', counterparty: 'title', instrumentName: 'title', type: 'eventType', settlementAccount: 'cashAccountNumber' },
};
const ING = { id: 'ing-es', service: 'ing', schema: 'transaction@1', keepRaw: true, currency: 'EUR', categories: ['banking'], fields: { internalId: 'transactionLocalUUID', date: 'transactionDate', amount: 'amount', description: 'description', type: 'transactionCode', account: '{group.iban}', balanceAfter: 'balance' } };
const REV = { id: 'revolut', service: 'revolut', schema: 'transaction@1', keepRaw: true, minorUnits: true, categories: ['banking'], fields: { internalId: 'id', date: 'startedDate', amount: 'amount', currency: 'currency', description: 'description', type: 'type', balanceAfter: 'balance', valueDate: 'completedDate' } };
const RECEIPT = { id: 'demo-shop', service: 'demo', schema: 'receipt@1', fields: { internalId: 'id', date: 'date', total: 'total', storeName: 'store' } };

test('needsMigration: only investment@2 / balanceAfter / valueDate / settlementAccount adapters', () => {
  assert.equal(needsMigration(TR), true);
  assert.equal(needsMigration(ING), true);
  assert.equal(needsMigration(REV), true);
  assert.equal(needsMigration(RECEIPT), false); // untouched sources are never rewritten
});

test('TR: an old transaction@1 record is upgraded to an investment@2 TRADE', () => {
  const old = { internalId: 'T1', date: '2026-02-03', amount: -20, currency: 'EUR', description: 'Demo Index ETF', counterparty: 'Demo Index ETF', type: 'TRADING_SAVINGSPLAN_EXECUTED', isin: 'XX0000000001', extra: { cashAccountNumber: 'ACC-DEMO', icon: 'logos/XX0000000001/v2', status: 'EXECUTED' } };
  const { record, changed } = renormalizeRecord(old, TR);
  assert.equal(changed, true);
  assert.equal(record.recordType, 'trade');
  assert.equal(record.side, 'buy');
  assert.deepEqual(record.instrument, { isin: 'XX0000000001', name: 'Demo Index ETF' });
  assert.equal(record.netAmount, -20);
  assert.equal(record.settlementAccount, 'ACC-DEMO'); // pulled from extra by the adapter's field mapping
  assert.ok(!('type' in record), 'transaction@1-only fields are dropped in the investment@2 shape');
});

test('TR: an old transfer/interest record becomes an investment@2 CASH movement', () => {
  const cash = { internalId: 'C1', date: '2026-02-05', amount: 0.01, currency: 'EUR', direction: 'credit', description: 'Interest', counterparty: 'Interest', type: 'INTEREST_PAYOUT', extra: { cashAccountNumber: 'ACC-DEMO', icon: 'logos/bank/v2' } };
  const { record } = renormalizeRecord(cash, TR);
  assert.equal(record.recordType, 'cash');
  assert.equal(record.kind, 'interest');
  assert.equal(record.amount, 0.01);
  assert.equal(record.direction, 'credit');
  assert.ok(!('instrument' in record), 'a cash movement has no instrument');
});

test('ING: balanceAfter is backfilled from record.extra.balance (no re-scale, not minorUnits)', () => {
  const old = { internalId: 'M1', date: '2026-03-01', amount: -12.5, currency: 'EUR', description: 'Compra', type: 'TPV', account: 'ES0000000000000000000000', extra: { balance: 980.5, concept: 'Compra' } };
  const { record, changed } = renormalizeRecord(old, ING);
  assert.equal(changed, true);
  assert.equal(record.balanceAfter, 980.5);
  assert.equal(record.amount, -12.5); // untouched — already normalized at store time
  assert.equal(record.account, 'ES0000000000000000000000');
});

test('Revolut: backfilled balance is minor-unit scaled; completedDate → ISO valueDate', () => {
  const old = { internalId: 'R1', date: '2026-03-01', amount: -12.34, currency: 'EUR', description: 'Shop', type: 'CARD_PAYMENT', extra: { balance: 250075, completedDate: '2026-03-02T10:00:00Z' } };
  const { record } = renormalizeRecord(old, REV);
  assert.equal(record.balanceAfter, 2500.75); // 250075 minor units → major (freshly pulled from extra = raw)
  assert.equal(record.amount, -12.34);         // already-scaled value left alone (no double scaling)
  assert.equal(record.valueDate, '2026-03-02');
});

test('idempotent: a record already in the new shape is unchanged', () => {
  const old = { internalId: 'M1', date: '2026-03-01', amount: -12.5, currency: 'EUR', description: 'Compra', type: 'TPV', account: 'ES0000000000000000000000', extra: { balance: 980.5, concept: 'Compra' } };
  const first = renormalizeRecord(old, ING).record;
  const second = renormalizeRecord(first, ING);
  assert.equal(second.changed, false);
});

// --- store-level walk with an in-memory backend + a stubbed config/state ---
import * as store from '../src/lib/store.js';

test('renormalizeStore rewrites affected sources in place and leaves others alone', async () => {
  const sources = {
    'ing-es:movimientos': { meta: {}, items: { M1: { at: '2026-03-01T00:00:00Z', record: { internalId: 'M1', date: '2026-03-01', amount: -5, currency: 'EUR', description: 'x', type: 'T', account: 'ES0000000000000000000000', extra: { balance: 100.25 } } } } },
    'demo-shop': { meta: {}, items: { r1: { at: '2026-01-01T00:00:00Z', record: { internalId: 'r1', date: '2026-01-01', total: 9.9, currency: 'EUR', store: { name: 'Demo' }, source: 'demo-shop' } } } },
  };
  const backend = { async listSources() { return Object.keys(sources); }, async loadSource(id) { return sources[id] || null; }, async saveSource(id, d) { sources[id] = d; } };
  store.setBackend(backend);
  try {
    const { changedAdapters, records } = await renormalizeStore({ 'ing-es': ING, 'demo-shop': RECEIPT });
    assert.equal(records, 1);
    assert.deepEqual([...changedAdapters], ['ing-es']);
    assert.equal(sources['ing-es:movimientos'].items.M1.record.balanceAfter, 100.25);
    assert.ok(!('balanceAfter' in sources['demo-shop'].items.r1.record), 'receipt source untouched');
  } finally { store.setBackend(null); }
});

test('resetReadWriteLedgers only clears read/write sink ledgers', () => {
  assert.ok(RW_SINK_TYPES.has('dropbox') && RW_SINK_TYPES.has('local-folder') && RW_SINK_TYPES.has('s3'));
  assert.ok(!RW_SINK_TYPES.has('download') && !RW_SINK_TYPES.has('http'), 'ephemeral/one-way sinks excluded');
});
