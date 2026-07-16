import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCapture, findComponentGroups } from '../src/runtime/infer.js';

// All fictional data — no real capture.

test('findComponentGroups detects sibling-key lists (mtop DIDA shape)', () => {
  const data = { data: { data: {
    pc_om_list_header_1: { fields: { title: 'x' } },              // singleton — ignored
    pc_om_list_order_A1: { fields: { orderId: 'A1', total: '1€' } },
    pc_om_list_order_A2: { fields: { orderId: 'A2', total: '2€' } },
    pc_om_list_order_A3: { fields: { orderId: 'A3', total: '3€' } },
  } } };
  const groups = findComponentGroups(data);
  const orders = groups.find((g) => g.prefix === 'pc_om_list_order_');
  assert.ok(orders, 'found the order group');
  assert.equal(orders.count, 3);
});

test('summarize: plain JSON-array list → auto-draftable HTTP', () => {
  const samples = [{ url: 'https://api.shop.com/orders', json: { orders: [{ id: 1, total: 5 }, { id: 2, total: 6 }] } }];
  const s = summarizeCapture(samples, []);
  assert.equal(s.transports.http, true);
  assert.equal(s.autoDraftable, true);
  assert.equal(s.needsMaintainer, false);
  assert.ok(s.documents >= 2);
});

test('summarize: mtop component-keyed → detected but needs a maintainer (signed)', () => {
  const samples = [{ url: 'https://acs.aliexpress.com/h5/mtop.aliexpress.trade.buyer.order.list/1.0/?x=1', json: { data: { data: {
    pc_om_list_order_A1: { fields: { orderId: 'A1' } },
    pc_om_list_order_A2: { fields: { orderId: 'A2' } },
  } } } }];
  const s = summarizeCapture(samples, []);
  assert.equal(s.transports.mtop, true);
  assert.ok(s.components >= 1);
  assert.equal(s.autoDraftable, false);       // signed mtop can't be replayed from offline samples
  assert.equal(s.needsMaintainer, true);
  assert.ok(s.documents >= 2);                 // still counts the user's data
});

test('summarize: WebSocket frames → realtime transport, needs a maintainer', () => {
  const ws = [
    { event: 'open', url: 'wss://api.tr.com/', frame: null },
    { event: 'send', url: 'wss://api.tr.com/', frame: 'sub 1 {"type":"timeline"}' },
    { event: 'recv', url: 'wss://api.tr.com/', frame: '{"items":[{"id":"t1"}]}' },
  ];
  const s = summarizeCapture([], ws);
  assert.equal(s.transports.ws, true);
  assert.equal(s.wsFrames, 3);
  assert.equal(s.needsMaintainer, true);
  assert.equal(s.autoDraftable, false);
});

test('summarize: nothing captured → empty, not draftable', () => {
  const s = summarizeCapture([], []);
  assert.equal(s.lists, 0);
  assert.equal(s.autoDraftable, false);
  assert.equal(s.needsMaintainer, false);
});
