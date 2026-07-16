import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory, artifactKinds, fetchArtifact } from '../src/runtime/inventory.js';
import { validateAdapter } from '../src/adapters/validate.js';
import { resolveOutput } from '../src/lib/outputs.js';

const here = dirname(fileURLToPath(import.meta.url));
const ADP = JSON.parse(readFileSync(join(here, '../../sources-repo/sources/aliexpress.json'), 'utf8'));
const EFF = resolveOutput(ADP, ADP.id);

// AliExpress orders come over Alibaba's mtop gateway; the page-context executor (net.mtop) returns each
// page's raw response and the runtime extracts the DIDA component-keyed orders (itemsFromKeys). Fictitious
// response mirroring the real shape: data.data.pc_om_list_order_<id>.fields, hasMore under pc_om_list_body_*.
const order = (id, dateText, priceText, store) => ({ fields: { orderId: id, orderDateText: dateText, totalPriceText: priceText, currencyCode: 'EUR', storeName: store, statusText: 'Finalizado', orderLines: [{ itemTitle: 'Widget' }] } });
const pageResp = (orders, hasMore) => ({ api: 'mtop.aliexpress.trade.buyer.order.list', ret: ['SUCCESS::调用成功'], data: { data: {
  'pc_om_list_header_110551': { fields: { pageTitle: 'Orders' } },
  'pc_om_list_body_109702': { fields: { hasMore, pageIndex: 2 } },
  ...Object.fromEntries(orders.map((o) => ['pc_om_list_order_' + o.fields.orderId, o])),
} } });

test('AliExpress adapter validates', () => { assert.ok(validateAdapter(ADP).ok, JSON.stringify(validateAdapter(ADP).errors)); });

test('mtop transport: extracts component-keyed orders across pages, maps to receipts', async () => {
  let cfg = null;
  const net = async () => ({ ok: false });
  net.mtop = async (c) => { cfg = c; return { pages: [
    pageResp([order('A1', '24 may, 2026', '2,28€', 'QH Store'), order('A2', '10 jun, 2026', '15,99€', 'DOMRAEM Store')], true),
    pageResp([order('A3', '6 jun, 2026', '3,97€', 'Shop Store')], false),
  ] }; };
  const docs = await listInventory(EFF, { merged: {}, byPath: {}, ctx: {} }, net, {});
  // the runtime hands the executor the mtop api + pagination config
  assert.equal(cfg.api, 'mtop.aliexpress.trade.buyer.order.list');
  assert.equal(cfg.pagePath, 'params~.data~.pc_om_list_body_*.fields.pageIndex');
  assert.equal(docs.length, 3);
  const byId = Object.fromEntries(docs.map((d) => [d.internalId, d.record]));
  assert.equal(byId.A1.date, '2026-05-24');            // "24 may, 2026" → ISO, no off-by-one
  assert.equal(byId.A1.total, 2.28);                    // "2,28€" parsed
  assert.equal(byId.A1.currency, 'EUR');
  assert.equal(byId.A1.store.name, 'QH Store');         // storeName → receipt store.name
  assert.equal(byId.A2.total, 15.99);
  assert.equal(byId.A3.date, '2026-06-06');
  assert.ok(byId.A1.extra, 'keepRaw kept the full order fields');
});

test('receipt: mtop detail → self-contained HTML invoice from the declarative template', async () => {
  // Fictional receipt (NO real data) mirroring queryorderreceiptinfo's shape: labels under mcms, values alongside.
  const receipt = {
    mcms: { mainTitle: 'Receipt', orderSummary: 'Order summary', orderIdTitle: 'Order ID', orderTimeTitle: 'Order date',
      shippingAddressTitle: 'Shipping address', paymentTitle: 'Payment', itemsDetailTitle: 'Items',
      allDiscountTitle: 'Discount', shippingFeeTitle: 'Shipping', includedTax: 'Incl. tax', orderTotal: 'Total' },
    orderId: 'A1', orderTime: '24 may, 2026',
    deliveryAddress: { contactName: 'TEST BUYER', addressSummaryInfoDisplay: '1 Test St, Testville', fullPhoneNo: '+00 000000000' },
    paymentInfo: { methodName: 'Visa', cardNo: '**** 0000', paymentAmountStr: '2,28€', paymentDate: '24 may, 2026' },
    subOrders: [{ itemTitle: 'Widget', amount: '2,28€' }],
    allDiscount: '0,05€', shippingFee: '0,00€', includedTaxDisplay: '0,43€', orderTotal: '2,28€',
  };
  let cfg = null;
  const net = async () => ({ ok: false });
  net.mtop = async (c) => { cfg = c; return { pages: [{ api: 'mtop.global.finance.taxation.invoice.queryorderreceiptinfo', data: { data: receipt } }] }; };
  const doc = { internalId: 'A1', record: { internalId: 'A1', total: 2.28, currency: 'EUR' } };

  const kinds = artifactKinds(EFF, doc);
  assert.ok(kinds.some((k) => k.kind === 'document' && k.ext === 'html'), 'produces an html document artifact');

  const art = await fetchArtifact(EFF, {}, doc, net, null, 'document');
  assert.equal(cfg.api, 'mtop.global.finance.taxation.invoice.queryorderreceiptinfo');
  assert.equal(cfg.data.orderId, 'A1');                 // params.orderId built from {internalId}
  assert.equal(cfg.data.shipToCountry, 'ES');           // literal params passed through
  const html = await art.blob.text();
  assert.equal(art.ext, 'html');
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Widget/);                          // item row
  assert.match(html, /TEST BUYER/);                      // address block
  assert.match(html, /Incl\. tax/);                      // mcms label used
  assert.match(html, /2,28€/);                           // total value
  assert.doesNotMatch(html, /mainTitle|deliveryAddress/); // raw keys never leak (template, not flatten)
});

test('mtop transport: surfaces an executor error, dedupes by orderId', async () => {
  const errNet = async () => ({ ok: false }); errNet.mtop = async () => ({ pages: [], error: 'no seed request captured' });
  await assert.rejects(listInventory(EFF, { merged: {}, byPath: {}, ctx: {} }, errNet, {}), /list mtop/);
  const dupNet = async () => ({ ok: false }); dupNet.mtop = async () => ({ pages: [pageResp([order('A1', '24 may, 2026', '1€', 'S')], true), pageResp([order('A1', '24 may, 2026', '1€', 'S')], false)] });
  const docs = await listInventory(EFF, { merged: {}, byPath: {}, ctx: {} }, dupNet, {});
  assert.equal(docs.length, 1);
});
