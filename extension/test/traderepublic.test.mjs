import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory } from '../src/runtime/inventory.js';
import { validateAdapter } from '../src/adapters/validate.js';
import { resolveOutput } from '../src/lib/outputs.js';

const here = dirname(fileURLToPath(import.meta.url));
const ADP = JSON.parse(readFileSync(join(here, '../../sources-repo/sources/traderepublic.json'), 'utf8'));
const EFF = resolveOutput(ADP, ADP.id);

// Trade Republic's timeline comes over a WebSocket, not HTTP. The runtime asks net.ws (a page-context WS
// executor) which returns the flat items array; the runtime maps each like a list row. Fictitious items,
// mirroring the real shape: decimal amount {value,currency}, ISO timestamp, eventType.
const item = (id, ts, value, currency, title, eventType) => ({
  id, timestamp: ts, title, subtitle: 'Completed', eventType, status: 'EXECUTED',
  amount: { value, currency, fractionDigits: 2 },
});
const ITEMS = [
  item('a1', '2026-07-13T12:24:31.555+0000', 50, 'EUR', 'Jane Doe', 'BANK_TRANSACTION_INCOMING'),
  item('a2', '2026-06-16T09:00:00.000+0000', -20, 'EUR', 'NASDAQ100 ETF', 'TRADING_SAVINGSPLAN_EXECUTED'),
  item('a3', '2026-06-01T08:00:00.000+0000', 0.01, 'EUR', 'Interest', 'INTEREST_PAYOUT'),
];
const auth = { merged: {}, byPath: {}, ctx: {} };
const mkNet = (result, capture) => { const net = async () => ({ ok: false, status: 404, json: async () => ({}) }); net.ws = async (cfg) => { if (capture) capture.cfg = cfg; return result; }; return net; };

test('Trade Republic adapter validates', () => { assert.ok(validateAdapter(ADP).ok, JSON.stringify(validateAdapter(ADP).errors)); });

test('ws transport: lists timeline via net.ws, maps decimal amounts + direction from sign', async () => {
  const cap = {};
  const docs = await listInventory(EFF, auth, mkNet({ items: ITEMS }, cap), {});
  // the runtime hands the executor the declared subscription + cursor config
  assert.equal(cap.cfg.url, 'wss://api.traderepublic.com');
  assert.equal(cap.cfg.sub.type, 'timelineTransactions');
  assert.equal(cap.cfg.cursorPath, 'cursors.after');
  assert.equal(docs.length, 3);
  const byId = Object.fromEntries(docs.map((d) => [d.internalId, d.record]));
  assert.equal(byId.a1.amount, 50);           // decimal value, no minor-unit scaling
  assert.equal(byId.a1.currency, 'EUR');
  assert.equal(byId.a1.direction, 'credit');   // +50 incoming
  assert.equal(byId.a1.date, '2026-07-13');    // ISO timestamp → date
  assert.equal(byId.a1.type, 'BANK_TRANSACTION_INCOMING');
  assert.equal(byId.a2.amount, -20);
  assert.equal(byId.a2.direction, 'debit');    // −20 savings-plan buy
  assert.equal(byId.a2.description, 'NASDAQ100 ETF');
});

test('ws transport: surfaces a socket error, and dedupes by id', async () => {
  await assert.rejects(listInventory(EFF, auth, mkNet({ items: [], error: 'ws error' }), {}), /list ws/);
  const dupes = await listInventory(EFF, auth, mkNet({ items: [ITEMS[0], ITEMS[0], ITEMS[1]] }), {});
  assert.equal(dupes.length, 2); // a1 deduped
});

test('ws transport: keepRaw keeps the full timeline item in record.extra', async () => {
  const docs = await listInventory(EFF, auth, mkNet({ items: [ITEMS[0]] }), {});
  assert.ok(docs[0].record.extra, 'record.extra present');
  assert.equal(docs[0].record.extra.status, 'EXECUTED');
});
