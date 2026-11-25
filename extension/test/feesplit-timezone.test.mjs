// Two runtime features first needed by Payoneer, written generically:
//  • `timeZone` on a source + a `dateTime` field: the service gives a wall-clock time with no zone, and the
//    source knows which zone it is (Payoneer's dashboard: America/New_York, daylight saving included). The
//    record then carries `dateTime` as ISO 8601 WITH the offset in force on that day, so a consumer can put
//    the movement on the right day in ITS own zone. `date` is left as it was.
//  • `list.feeSplit`: a movement whose amount silently includes a fee (a withdrawal: -87 out of the balance,
//    83.52 reaching the bank) is split in two — the net transfer and the fee as its own movement — using the
//    fee from a per-item detail endpoint, so the transfer matches the bank's credit to the cent.
//
// Every value is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listInventory, zonedToIso } from '../src/runtime/inventory.js';

test('zonedToIso: a New York wall time gets -05:00 in winter and -04:00 in summer', () => {
  assert.equal(zonedToIso('2026-11-05T09:55:38.51', 'America/New_York'), '2026-11-05T09:55:38.510-05:00');
  assert.equal(zonedToIso('2025-08-18T07:58:00', 'America/New_York'), '2025-08-18T07:58:00.000-04:00');
  assert.equal(zonedToIso('2026-03-08T01:30:00', 'America/New_York'), '2026-03-08T01:30:00.000-05:00'); // before the switch
  assert.equal(zonedToIso('2026-03-08T03:30:00', 'America/New_York'), '2026-03-08T03:30:00.000-04:00'); // after it
  assert.equal(zonedToIso('2026-07-01T12:00:00', 'Europe/Madrid'), '2026-07-01T12:00:00.000+02:00');
});

test('zonedToIso: a value that already has a zone, or is not a timestamp, is left alone', () => {
  assert.equal(zonedToIso('2026-11-05T14:55:38Z', 'America/New_York'), '2026-11-05T14:55:38Z');
  assert.equal(zonedToIso('2026-11-05T14:55:38+01:00', 'America/New_York'), '2026-11-05T14:55:38+01:00');
  assert.equal(zonedToIso('2026-11-05', 'America/New_York'), '2026-11-05');
  assert.equal(zonedToIso('2026-11-05T09:55:38', undefined), '2026-11-05T09:55:38');
});

const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
const SRC = {
  id: 'demo-wallet', name: 'Demo wallet', schema: 'transaction@1', timeZone: 'America/New_York',
  match: ['https://wallet.example.com/*'],
  api: {
    host: 'https://wallet.example.com',
    list: {
      path: '/api/tx', itemsPath: 'items', paging: 'none',
      feeSplit: {
        when: { field: 'kind', values: ['withdrawal'] },
        detail: { path: '/api/tx/detail', params: { id: '{id}', kind: '{kind}' } },
        feeField: 'main.Fee',
        type: 'fee', description: 'Withdrawal fee',
      },
    },
  },
  fields: { internalId: 'id', date: 'at', dateTime: 'at', amount: 'amount', currency: 'cur', balanceAfter: 'bal', description: 'who', type: 'kind' },
};
const ITEMS = [
  { id: 'W1', kind: 'withdrawal', at: '2026-11-05T14:02:39.72', amount: '-87.00', cur: 'USD', bal: '0.00', who: 'My Bank' },
  { id: 'P1', kind: 'payment', at: '2026-11-05T09:55:38.51', amount: '146.74', cur: 'USD', bal: '87.00', who: 'ACME' },
  { id: 'W2', kind: 'withdrawal', at: '2025-08-18T07:58:00', amount: '-50.00', cur: 'USD', bal: '10.00', who: 'My Bank' },
];
const FEES = { W1: -3.48, W2: 0 };
function net({ failFor } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith('https://wallet.example.com/api/tx/detail')) {
      const id = new URL(url).searchParams.get('id');
      if (id === failFor) return { ok: false, status: 500, text: async () => 'boom' };
      return ok({ main: { Fee: FEES[id] } });
    }
    if (url.startsWith('https://wallet.example.com/api/tx')) return ok({ items: ITEMS });
    return { ok: false, status: 404, text: async () => '' };
  };
  return { fn, calls };
}
const AUTH = { merged: { authorization: 'Bearer EXAMPLEEXAMPLEEXAMPLE' }, byPath: {} };

test('feeSplit: the withdrawal becomes the net transfer plus a separate fee movement', async () => {
  const n = net();
  const docs = await listInventory(SRC, AUTH, n.fn);
  const by = (id) => docs.find((d) => d.internalId === id);
  const w = by('W1'), fee = by('W1|fee');
  assert.ok(w && fee, 'both movements');
  assert.equal(w.record.amount, -83.52);
  assert.equal(fee.record.amount, -3.48);
  assert.equal(fee.record.type, 'fee');
  assert.equal(fee.record.description, 'Withdrawal fee');
  assert.equal(fee.record.currency, 'USD');
  assert.equal(fee.record.date, w.record.date);
  // Running balance stays continuous: the transfer leaves 3.48, the fee takes it to the original 0.
  assert.equal(w.record.balanceAfter, 3.48);
  assert.equal(fee.record.balanceAfter, 0);
  // Only matching items cost a detail request, with the item's own values and the session.
  const details = n.calls.filter((c) => c.url.includes('/detail'));
  assert.equal(details.length, 2);
  assert.ok(details.some((c) => c.url.includes('id=W1') && c.url.includes('kind=withdrawal')));
  assert.equal(details[0].init.headers.authorization, AUTH.merged.authorization);
  // A withdrawal with no fee stays whole and gets no fee movement.
  assert.equal(by('W2').record.amount, -50);
  assert.ok(!by('W2|fee'));
  assert.equal(by('P1').record.amount, 146.74);
});

test('feeSplit: a failed detail drops that movement from this run (retried next time), never half-split', async () => {
  const docs = await listInventory(SRC, AUTH, net({ failFor: 'W1' }).fn);
  assert.ok(!docs.some((d) => String(d.internalId).startsWith('W1')));
  assert.ok(docs.some((d) => d.internalId === 'P1'));
  assert.equal(docs.stats.skippedFeeDetail, 1);
});

test('timeZone: records carry dateTime with the offset; date is unchanged', async () => {
  const docs = await listInventory(SRC, AUTH, net().fn);
  const by = (id) => docs.find((d) => d.internalId === id).record;
  assert.equal(by('P1').dateTime, '2026-11-05T09:55:38.510-05:00');
  assert.equal(by('P1').date, '2026-11-05');
  assert.equal(by('W2').dateTime, '2025-08-18T07:58:00.000-04:00');
  assert.equal(by('W1|fee').dateTime, by('W1').dateTime);
});

test('timeZone: dateTime survives the canonical shape a sink can ask for', async () => {
  const { canonicalize } = await import('../src/lib/normalize.js');
  const docs = await listInventory(SRC, AUTH, net().fn);
  assert.equal(canonicalize(docs.find((d) => d.internalId === 'P1').record).dateTime, '2026-11-05T09:55:38.510-05:00');
});
