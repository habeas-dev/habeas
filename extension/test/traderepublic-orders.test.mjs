// Trade Republic one-off orders and IPO subscriptions, not only savings plans. A savings-plan execution is
// always a buy, so its eventType alone gave `side`; a regular order's eventType (TRADING_TRADE_EXECUTED) is the
// SAME for a buy and a sell, and an IPO goes through two events of its own. With `side` left as the raw event
// type, a consumer cannot book the trade at all (Cuéntamo rejects a trade without a valid side), so the orders
// silently never arrived while the savings plans did.
//  - regular order: the side is in the list item's subtitle ("Buy Order" / "Sell Order"), and units, price and
//    fee sit in the detail's "Overview" section (the Transaction row opens a sheet with Shares / Share price);
//  - IPO_SUBSCRIPTION_ALLOCATION: the shares actually received — a buy, for what was really charged;
//  - IPO_SUBSCRIPTION_CREATED: only a reservation of cash, partly refunded at allocation. It is NOT a trade and
//    not a movement of its own: the allocation's amount is already the net, so delivering both would count it
//    twice. The ws list drops it (api.ws.keep, the same filter an HTTP list has).
// Every value is invented; the layout mirrors the real one.
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
const EFF = resolveOutput(ADP, 'transactions');
const auth = { merged: {}, byPath: {}, ctx: {} };
const mkNet = (items) => { const net = async () => ({ ok: false, status: 404, json: async () => ({}) }); net.ws = async () => ({ items }); return net; };

const ISIN = 'US0000000AB1';
const row = (title, text) => ({ title, style: 'plain', detail: { type: 'text', text, displayValue: { text } } });
// The order layout: Overview { <Buy|Sell|IPO Subscription>, Asset, Transaction → sheet {Share price, Shares, Total}, Fee, Total }
const orderDetail = (id, statusTitle, shares, price, fee, total) => ({
  id,
  sections: [
    { type: 'header', title: 'You invested ' + total, data: { status: 'executed' } },
    {
      type: 'table', title: 'Overview',
      data: [
        { title: statusTitle, style: 'plain', detail: { type: 'status', text: 'Executed', functionalStyle: 'EXECUTED' } },
        row('Asset', 'Example Corp'),
        {
          title: 'Transaction', style: 'plain',
          detail: {
            type: 'text', text: shares + ' × ' + price,
            action: { type: 'infoPage', payload: { id: '00000000-0000-0000-0000-000000000000', sections: [
              { type: 'header', title: 'Transaction', data: { status: 'executed' } },
              { type: 'table', data: [row('Share price', price), row('Shares', String(shares)), row('Total', total)] },
            ] } },
          },
        },
        row('Fee', fee),
        row('Total', total),
      ],
    },
  ],
});
const item = (id, eventType, subtitle, value, detail) => ({
  id, timestamp: '2026-03-10T10:00:00.000+0000', title: 'Example Corp', subtitle, eventType, status: 'EXECUTED',
  icon: 'logos/' + ISIN + '/v2', amount: { value, currency: 'EUR', fractionDigits: 2 }, detail,
});
const ITEMS = [
  item('buy1', 'TRADING_TRADE_EXECUTED', 'Buy Order', -41.4, orderDetail('buy1', 'Buy', 2, '€20.20', '€1.00', '€41.40')),
  item('sell1', 'TRADING_TRADE_EXECUTED', 'Sell Order', 29.5, orderDetail('sell1', 'Sell', 1, '€30.50', '€1.00', '€29.50')),
  item('limit1', 'TRADING_TRADE_EXECUTED', 'Limit Sell Order', 9.5, orderDetail('limit1', 'Sell', 1, '€10.50', '€1.00', '€9.50')),
  item('ipo-req', 'IPO_SUBSCRIPTION_CREATED', 'Subscription', -101, undefined),
  item('ipo-alloc', 'IPO_SUBSCRIPTION_ALLOCATION', 'IPO', -13.123456, orderDetail('ipo-alloc', 'IPO Subscription', 1, '€12.123456', '€1.00', '€13.12')),
  item('plan1', 'TRADING_SAVINGSPLAN_EXECUTED', 'Savings Plan executed', -25, undefined),
  // The OLDER layout (2024): TRADE_INVOICE, Overview { Status, Order Type, Asset }, same "Buy Order" subtitle.
  item('old1', 'TRADE_INVOICE', 'Buy Order', -60, { id: 'old1', sections: [{ type: 'table', title: 'Overview',
    data: [row('Status', 'Executed'), row('Order Type', 'Buy'), row('Asset', 'Example Corp')] }] }),
];

const byId = async () => Object.fromEntries((await listInventory(EFF, auth, mkNet(ITEMS), {})).map((d) => [d.internalId, d.record]));

test('the Trade Republic source still validates', () => { assert.ok(validateAdapter(ADP).ok, JSON.stringify(validateAdapter(ADP).errors)); });

test('a regular buy order is a buy, with its units, price and fee', async () => {
  const r = (await byId()).buy1;
  assert.equal(r.recordType, 'trade');
  assert.equal(r.side, 'buy');
  assert.equal(r.instrument.isin, ISIN);
  assert.equal(r.netAmount, -41.4);
  assert.equal(Number(r.units), 2);
  assert.equal(r.price, 20.2);
  assert.equal(r.commission, 1);
});

test('a sell order — market or limit — is a sell, though its eventType is the same as a buy\'s', async () => {
  const all = await byId();
  assert.equal(all.sell1.side, 'sell');
  assert.equal(all.sell1.netAmount, 29.5);
  assert.equal(Number(all.sell1.units), 1);
  assert.equal(all.limit1.side, 'sell');
});

test('an IPO allocation is a buy of the shares received, at the amount really charged', async () => {
  const r = (await byId())['ipo-alloc'];
  assert.equal(r.side, 'buy');
  assert.equal(r.netAmount, -13.123456);
  assert.equal(Number(r.units), 1);
  assert.equal(r.commission, 1);
});

test('an IPO subscription request is not delivered: only reserved cash, already netted in the allocation', async () => {
  const all = await byId();
  assert.equal('ipo-req' in all, false);
});

test('savings plans keep working as before', async () => {
  const r = (await byId()).plan1;
  assert.equal(r.side, 'buy');
  assert.equal(r.netAmount, -25);
});

test('an older-layout order keeps its previous behaviour: not turned into a trade by this change', async () => {
  // Those events predate the WebSocket source and a consumer may already hold them from Trade Republic's own
  // CSV export, under that file's references (split per execution lot), which a Habeas id can never match:
  // turning them into trades now would book every one of them twice. Only the current layout is read.
  const r = (await byId()).old1;
  assert.notEqual(r.side, 'buy');
});
