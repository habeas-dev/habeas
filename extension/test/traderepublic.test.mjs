import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory, fetchArtifact, artifactKinds } from '../src/runtime/inventory.js';
import { validateAdapter } from '../src/adapters/validate.js';
import { resolveOutput } from '../src/lib/outputs.js';

const here = dirname(fileURLToPath(import.meta.url));
const ADP = JSON.parse(readFileSync(join(here, '../../sources-repo/sources/traderepublic.json'), 'utf8'));
const EFF = resolveOutput(ADP, 'transactions'); // the WebSocket timeline stream

// Trade Republic's timeline comes over a WebSocket, not HTTP. The runtime asks net.ws (a page-context WS
// executor) which returns the flat items array; the runtime maps each like a list row. Fictitious items,
// mirroring the real shape: decimal amount {value,currency}, ISO timestamp, eventType.
const item = (id, ts, value, currency, title, eventType, icon) => ({
  id, timestamp: ts, title, subtitle: 'Completed', eventType, status: 'EXECUTED', icon,
  amount: { value, currency, fractionDigits: 2 },
});
const ITEMS = [
  item('a1', '2026-07-13T12:24:31.555+0000', 50, 'EUR', 'Jane Doe', 'BANK_TRANSACTION_INCOMING', 'logos/contacts-D-Grey/v2'),
  item('a2', '2026-06-16T09:00:00.000+0000', -20, 'EUR', 'NASDAQ100 ETF', 'TRADING_SAVINGSPLAN_EXECUTED', 'logos/IE00B53SZB19/v2'),
  item('a3', '2026-06-01T08:00:00.000+0000', 0.01, 'EUR', 'Interest', 'INTEREST_PAYOUT', 'logos/bank/v2'),
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
  // investment@2: an incoming bank transfer is a CASH movement (no instrument), kind mapped from eventType
  assert.equal(byId.a1.recordType, 'cash');
  assert.equal(byId.a1.kind, 'deposit');       // BANK_TRANSACTION_INCOMING → deposit
  assert.equal(byId.a1.amount, 50);            // decimal value, no minor-unit scaling
  assert.equal(byId.a1.currency, 'EUR');
  assert.equal(byId.a1.direction, 'credit');   // +50 incoming
  assert.equal(byId.a1.date, '2026-07-13');    // ISO timestamp → date
  assert.ok(!('instrument' in byId.a1), 'a cash movement has no instrument');
  // a savings-plan execution is a TRADE: recordType from the extracted ISIN, side from the eventType
  assert.equal(byId.a2.recordType, 'trade');
  assert.equal(byId.a2.side, 'buy');           // TRADING_SAVINGSPLAN_EXECUTED → buy
  assert.equal(byId.a2.instrument.isin, 'IE00B53SZB19', 'ISIN extracted from the trade icon path');
  assert.equal(byId.a2.instrument.name, 'NASDAQ100 ETF');
  assert.equal(byId.a2.netAmount, -20);        // cash impact of the buy
  // interest is a CASH movement
  assert.equal(byId.a3.recordType, 'cash');
  assert.equal(byId.a3.kind, 'interest');      // INTEREST_PAYOUT → interest
});

test('ws transport: surfaces a socket error, and dedupes by id', async () => {
  await assert.rejects(listInventory(EFF, auth, mkNet({ items: [], error: 'ws error' }), {}), /list ws/);
  const dupes = await listInventory(EFF, auth, mkNet({ items: [ITEMS[0], ITEMS[0], ITEMS[1]] }), {});
  assert.equal(dupes.length, 2); // a1 deduped
});

test('ws transport: keepRaw keeps the full timeline item + attached detail in record.extra', async () => {
  const cap = {};
  const docs = await listInventory(EFF, auth, mkNet({ items: [ITEMS[0]] }, cap), {});
  assert.ok(docs[0].record.extra, 'record.extra present');
  assert.equal(docs[0].record.extra.status, 'EXECUTED');
  // the runtime asks the executor to enrich each item with its detail subscription
  assert.equal(cap.cfg.detail.subType, 'timelineDetailV2');

  // a trade item the executor enriched with its timelineDetailV2 detail (asset, quantity × price, fees)
  const trade = { ...item('t9', '2026-06-16T09:00:00.000+0000', -12, 'EUR', 'Commodity ETF', 'TRADING_SAVINGSPLAN_EXECUTED'),
    detail: { id: 't9', sections: [{ type: 'table', title: 'Resumen', data: [{ title: 'Transacción', detail: { text: '1,47 × 8,13 €' } }] }] } };
  const [d2] = await listInventory(EFF, auth, mkNet({ items: [trade] }), {});
  assert.ok(d2.record.extra.detail, 'attached WS detail preserved in record.extra.detail');
  assert.equal(d2.record.extra.detail.sections[0].title, 'Resumen');
});

// Monthly documents (invoice stream): the account statement PDF (direct GET, per month) and the monthly
// transactions CSV (async export job: POST → poll status → download). Synthetic per-completed-month items.
test('statements: account statement PDF is a direct per-month GET', async () => {
  const PDF = resolveOutput(ADP, 'extracto/pdf');
  let url = null;
  const net = async (u) => { const x = new URL(u, 'https://api.traderepublic.com'); if (x.pathname.endsWith('/accountstatement/statement')) { url = x.pathname + '?' + x.searchParams.toString(); return { ok: true, status: 200, blob: async () => new Blob(['%PDF']), text: async () => '', headers: { get: () => 'application/pdf' } }; } return { ok: false, status: 404, json: async () => ({}) }; };
  const docs = await listInventory(PDF, auth, net, {});
  assert.ok(docs.length >= 1 && docs[0].internalId.match(/^\d{4}-\d{2}$/));
  await fetchArtifact(PDF, auth, docs[0], net, null, artifactKinds(PDF, docs[0])[0].kind);
  assert.match(url, /\/accountstatement\/statement\?fromDate=\d{4}-\d{2}&toDate=\d{4}-\d{2}$/);
});

test('statements: transactions CSV is an async export job (POST → poll → download)', async () => {
  const CSV = resolveOutput(ADP, 'extracto/csv');
  const calls = [];
  const net = async (u, init) => {
    const x = new URL(u, 'https://api.traderepublic.com'); const p = x.pathname;
    calls.push({ m: (init && init.method) || 'GET', p, body: init && init.body });
    if (p.endsWith('/export/request')) return { ok: true, status: 202, text: async () => JSON.stringify({ jobId: 'J1', status: 'PENDING' }) };
    if (p.endsWith('/export/status')) return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'COMPLETED' }) };
    if (p.endsWith('/export/download')) return { ok: true, status: 200, blob: async () => new Blob(['a,b']), text: async () => '', headers: { get: () => 'text/csv' } };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const docs = await listInventory(CSV, auth, net, {});
  assert.deepEqual(artifactKinds(CSV, docs[0]), [{ kind: 'document', ext: 'csv' }]);
  const blob = await fetchArtifact(CSV, auth, docs[0], net, null, artifactKinds(CSV, docs[0])[0].kind);
  const start = calls.find((c) => c.p.endsWith('/export/request'));
  assert.equal(start.m, 'POST');
  assert.match(start.body, /^\{"from":"\d{4}-\d{2}-01","to":"\d{4}-\d{2}-\d{2}"\}$/); // JSON body filled, not treated as a template
  assert.ok(calls.some((c) => c.p.endsWith('/export/status') && c.p.includes) && calls.some((c) => c.p.endsWith('/export/download')));
  assert.ok(blob);
});
