// Payoneer: no API for your own account (its transactions API is PSD2-only), so the source reads the
// dashboard's own JSON with its session: an opaque bearer the SPA keeps in sessionStorage `ui-auth`. One group
// per currency balance (the monthly-statement picker lists them; the USD one shows up as a "card" balance), and
// each balance's movements filtered server-side by `paymentMethodIds[]`.
//
// Shaped like the real responses; every value is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory } from '../src/runtime/inventory.js';
import { validateAdapter } from '../src/adapters/validate.js';
import { buildRecord } from '../src/sinks/format.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = JSON.parse(readFileSync(join(ROOT, 'sources-repo/sources/payoneer.json'), 'utf8'));
const USD = '9001', EUR = '9002', GBP = '9003', BANK = '9009';
const AUTH = { merged: { authorization: 'Bearer AbCdEfGhIjKlMnOpQrStUvWx12' }, byPath: {} };
const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });

const opt = (Value, GroupId, ResParams, Value2) => ({ Icon: 'x', IsCanceled: false, GroupId, Value, Text: { Value: Value2 ?? null, ResKey: ResParams ? 'k' : null, ResParams: ResParams ?? null }, ProcessorType: 1 });
const PICKER = { BalanceOption: [
  opt(EUR, 0, { Currency: 'EUR' }), opt(GBP, 0, { Currency: 'GBP' }),
  opt(USD, 1, { CardMaskedNumber: 'XXXX-0000', Currency: 'USD' }),
  opt(BANK, 2, null, 'My Bank USD'), // a withdrawal bank account: not a balance
] };
const tx = (id, type, date, amount, cur, bal, account, params, status = 2) => ({
  ActivityId: id, Icon: 'icon', TypeId: type, Date: date,
  Description: { Value: null, ResKey: params ? 'ActivityDescription_' + type + '.Text' : null, ResParams: params || {} },
  ActivityName: null, Amount: { Value: null, ResKey: 'k', ResParams: { Amount: amount, Currency: cur } }, Account: account,
  Balance: { Value: null, ResKey: 'k', ResParams: { Amount: bal, Currency: cur } }, Status: { Value: null, ResKey: 'ActivityStatus_' + status + '.Text', ResParams: null },
  SplitAmount: { Amount: amount, Currency: cur, State: null, AmountTooltipContent: null }, SplitBalance: { Amount: bal, Currency: cur, State: null },
  HasStatement: type === 1, ActivityItemStatus: status, HasButton: false, StatusTooltipContent: null,
});
const BY_ACCOUNT = {
  [USD]: [
    tx('1000000003', 1, '2026-03-08T04:10:00.12', '-100.00', 'USD', '0.00', USD, { BankName: 'My Bank USD' }),
    tx('7000000102', 24, '2026-03-08T04:09:00.5', '-20.50', 'USD', '100.00', USD, null),
    tx('1000000001', 15, '2026-03-07T13:40:12.3', '120.50', 'USD', '120.50', USD, { sender_email: 'ACME  Inc' }),
  ],
  [EUR]: [
    tx('1000000010', 10, '2026-02-01T01:00:00.0', '1.00', 'EUR', '0.00', EUR, { ActivityItemDescription: 'Verification' }, 3),
    tx('1000000011', 6, '2026-01-15T10:00:00.0', '50.00', 'EUR', '50.00', EUR, { Payment_from: 'Client Ltd' }),
  ],
  [GBP]: [],
};

function net() {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('/statements/MonthlyStatementData')) return ok(PICKER);
    if (url.includes('/activity/getMainTransactions')) {
      const acc = new URL(url).searchParams.get('paymentMethodIds[]');
      return ok({ Filters: null, TransactionsDataState: 2, TotalMainTransactionsCount: (BY_ACCOUNT[acc] || []).length, Transactions: BY_ACCOUNT[acc] || [] });
    }
    return { ok: false, status: 404, text: async () => 'unexpected ' + url };
  };
  return { fn, calls };
}

test('payoneer: the definition validates', () => {
  const v = validateAdapter(SRC);
  assert.deepEqual(v.errors || [], []);
});

test('payoneer: one listing per currency balance (not bank accounts), filtered server-side, bearer replayed', async () => {
  const n = net();
  const docs = await listInventory(SRC, AUTH, n.fn);
  const lists = n.calls.filter((c) => c.url.includes('getMainTransactions'));
  assert.deepEqual(lists.map((c) => new URL(c.url).searchParams.get('paymentMethodIds[]')).sort(), [USD, EUR, GBP].sort());
  for (const c of lists) {
    const q = new URL(c.url).searchParams;
    assert.equal(q.get('fromDate'), '2000-01-01');
    assert.equal(q.get('numberOfResults'), '1000');
    assert.equal(c.init.headers.authorization, AUTH.merged.authorization);
  }
  // Completed movements only: the EUR verification deposit (status 3) is dropped.
  assert.deepEqual(docs.map((d) => d.internalId).sort(), ['1000000001', '1000000003', '1000000011', '7000000102']);
});

test('payoneer: a movement becomes a transaction with signed amount, balance, the other party and its type', async () => {
  const docs = await listInventory(SRC, AUTH, net().fn);
  const rec = (id) => buildRecord(docs.find((d) => d.internalId === id), SRC);
  const pay = rec('1000000001');
  assert.equal(pay.amount, 120.5);
  assert.equal(pay.currency, 'USD');
  assert.equal(pay.direction, 'credit');
  assert.equal(pay.balanceAfter, 120.5);
  assert.equal(pay.description, 'ACME  Inc');
  assert.equal(pay.counterparty, 'ACME  Inc');
  assert.equal(String(pay.type), '15');
  assert.equal(pay.date.slice(0, 10), '2026-03-07');
  const w = rec('1000000003');
  assert.equal(w.amount, -100);
  assert.equal(w.direction, 'debit');
  assert.equal(w.counterparty, 'My Bank USD');
  const fee = rec('7000000102');
  assert.equal(fee.amount, -20.5);
  assert.equal(String(fee.type), '24');
  assert.equal(fee.description, '');
  assert.equal(rec('1000000011').counterparty, 'Client Ltd');
});

test('payoneer: each record names the balance it belongs to', async () => {
  const docs = await listInventory(SRC, AUTH, net().fn);
  const g = (id) => docs.find((d) => d.internalId === id)._group;
  assert.equal(g('1000000001').id, USD);
  assert.equal(g('1000000001').currency, 'USD');
  assert.equal(g('1000000011').id, EUR);
});
