import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory, fetchDetail, fetchPdf, extractDetailFields } from '../src/runtime/inventory.js';

// The REAL shipped adapter (sources-repo/sources/amazon-es.json) is exercised here against SYNTHETIC
// HTML fixtures (small, invented — they mirror the real Amazon structures but carry NO real user data).
const here = dirname(fileURLToPath(import.meta.url));
const AMAZON = JSON.parse(readFileSync(join(here, '../../sources-repo/sources/amazon-es.json'), 'utf8'));
const AUTH = { byPath: {}, merged: {} }; // cookie auth → no replay headers

const YEAR = new Date().getFullYear();

// --- synthetic fixtures ---------------------------------------------------------------------------
// An orders page: two order-cards, each identified only by its slot-id (date/total are client-side
// encrypted on the real page, so the list yields ONLY orderIDs — exactly what we assert).
const ORDERS_HTML = `<!DOCTYPE html><html><body>
  <div class="order-card" data-csa-c-content-id="amzn1.yourorders.order-card"
       data-csa-c-slot-id="amzn1.yourorders.order-card.111-2222222-3333333">
    <div class="a-box">an order</div>
  </div>
  <div class="order-card" data-csa-c-content-id="amzn1.yourorders.order-card"
       data-csa-c-slot-id="amzn1.yourorders.order-card.444-5555555-6666666">
    <div class="a-box">another order</div>
  </div>
</body></html>`;

// An order-details page: data lives in data-component="X" regions; the grand total is the bold
// "Importe total" row; items are itemTitle → /dp/<ASIN> anchors.
const DETAIL_HTML = `<!DOCTYPE html><html><body>
  <div data-component="orderDate"><span>15 de marzo de 2025 <i class="a-icon"></i></span></div>
  <div data-component="orderIdLabel"><span>Pedido n.&ordm;</span></div>
  <div data-component="orderId"><span>111-2222222-3333333</span></div>
  <div data-component="purchasedItems">
    <div data-component="itemTitle"><div class="a-row"><a class="a-link-normal"
      href="/dp/B01ABCDEFG?ref_=ppx_hzod_title">Widget de Prueba Uno</a></div></div>
    <div data-component="itemTitle"><div class="a-row"><a class="a-link-normal"
      href="/dp/B09ZZ12345?ref_=ppx_hzod_title">Cosa de Prueba Dos</a></div></div>
  </div>
  <div data-component="briefOrderInfoInvoice"><span>Importe total: 0,00 €</span></div>
  <div data-component="chargeSummary">
    <span>Resumen del pedido</span>
    <span>Subtotal de producto(s):</span> <span>24,99 €</span>
    <span>Env&iacute;o:</span> <span>0,00 €</span>
    <span>Total antes de impuestos:</span> <span>24,99 €</span>
    <span>Impuestos:</span> <span>0,00 €</span>
    <div><span>Total:</span></div><div><span class="a-text-bold">24,99 €</span></div>
    <div><span>Importe del cheque regalo:</span></div>
  </div>
</body></html>`;

// Invoice popover with a real Factura link → the 2-step PDF resolves.
const POPOVER_WITH = `<ul class="invoice-list"><li><span><a href="/gp/css/summary/print.html?orderID=111-2222222-3333333">Resumen del pedido imprimible</a></span></li>` +
  `<li><span><a href="/documents/download/aaaa1111-bbbb-2222-cccc-333344445555/invoice.pdf">Factura</a></span></li>` +
  `<li><span><a href="/gp/help/contact/contact.html?orderID=111-2222222-3333333">Solicitar factura</a></span></li></ul>`;
// Invoice popover WITHOUT a Factura link → metadata-only (no invoice was issued yet).
const POPOVER_NONE = `<ul class="invoice-list"><li><span><a href="/gp/css/summary/print.html?orderID=444-5555555-6666666">Resumen del pedido imprimible</a></span></li>` +
  `<li><span><a href="/gp/help/contact/contact.html?orderID=444-5555555-6666666">Solicitar factura</a></span></li></ul>`;

const FAKE_PDF = '%PDF-1.4\n1 0 obj fake invoice\n%%EOF';

function res(body, { ok = true, status = 200, blob = null } = {}) {
  return { ok, status, text: async () => body, json: async () => JSON.parse(body), blob: async () => (blob || new Blob([body])) };
}

// A configurable mock server. `popover` picks which popover HTML the invoice resolver returns.
function amazonNet(popover = POPOVER_WITH) {
  return async (url) => {
    const u = new URL(url);
    if (u.pathname === '/your-orders/orders') {
      const tf = u.searchParams.get('timeFilter');
      const start = u.searchParams.get('startIndex');
      // Only the current year's first page has orders; every other year/page is empty.
      if (tf === 'year-' + YEAR && !start) return res(ORDERS_HTML);
      return res('<html><body>no orders</body></html>');
    }
    if (u.pathname === '/your-orders/order-details') return res(DETAIL_HTML);
    if (u.pathname === '/your-orders/invoice/popover') return res(popover);
    if (u.pathname.startsWith('/documents/download/')) return res(FAKE_PDF, { blob: new Blob([FAKE_PDF], { type: 'application/pdf' }) });
    return res('nope', { ok: false, status: 404 });
  };
}

// --------------------------------------------------------------------------------------------------
test('Amazon list: yields the orderIDs from the order-cards (year-partitioned, deduped)', async () => {
  const docs = await listInventory(AMAZON, AUTH, amazonNet());
  assert.deepEqual(docs.map((d) => d.internalId).sort(), ['111-2222222-3333333', '444-5555555-6666666']);
});

test('Amazon detail: parses the order-details HTML into a structured record (ISO date, numeric total, items)', async () => {
  const doc = { internalId: '111-2222222-3333333' };
  const { blob, via } = await fetchDetail(AMAZON, AUTH, doc, amazonNet());
  assert.equal(via, 'html-fields');
  const rec = JSON.parse(await blob.text());
  assert.equal(rec.orderId, '111-2222222-3333333');
  assert.equal(rec.date, '2025-03-15');      // "15 de marzo de 2025" → ISO
  assert.equal(rec.total, 24.99);            // "24,99 €" (bold Importe total) → number
  assert.equal(rec.currency, 'EUR');         // detail.const
  assert.ok(!rec.returnStatus);              // a normal (non-returned) order → empty
  assert.deepEqual(rec.items, [
    { asin: 'B01ABCDEFG', title: 'Widget de Prueba Uno' },
    { asin: 'B09ZZ12345', title: 'Cosa de Prueba Dos' },
  ]);
});

test('Amazon detail: flags a returned/refunded order from its shipmentStatus (partial returns too)', () => {
  const cfg = AMAZON.api.detail; // uses the real returnStatus extractor from the source
  const refunded = '<div data-component="shipmentStatus"><span class="a-size-base od-status-message"><span>Reembolsado</span> No necesitas devolver tu producto.</span></div>'
    + '<div class="a-row"><span>Reembolso de artículos</span></div><div class="od-line-item-row-content"><span class="a-size-base">3,30 €</span></div>';
  const partial = '<div data-component="shipmentStatus"><span class="od-status-message"><span>Entregado</span></span></div>'
    + '<div data-component="shipmentStatus"><span class="od-status-message"><span>Devolución completada</span></span></div>';
  const normal = '<div data-component="shipmentStatus"><span class="od-status-message"><span>Entregado</span> el 3 de julio</span></div>';
  assert.equal(extractDetailFields(refunded, cfg).returnStatus, 'Reembolsado');
  assert.equal(extractDetailFields(refunded, cfg).refundTotal, 3.3); // refunded amount → number
  assert.equal(extractDetailFields(partial, cfg).returnStatus, 'Devolución completada'); // one item returned still flags the order
  assert.ok(!extractDetailFields(normal, cfg).returnStatus);
  assert.ok(!extractDetailFields(normal, cfg).refundTotal);
});

test('Amazon detail: extracts payment method name + last4 from the escaped Next.js JSON, picking the card over a gift card', () => {
  const cfg = AMAZON.api.detail; // real paymentMethod/paymentLast4 extractors from the source
  // Escaped JSON as it appears in the order-details HTML: a gift card (no lastDigits) THEN the card.
  const pm = '\\"paymentMethodHeader\\":\\"Cheque regalo de Amazon\\",\\"paymentMethodCardArtInfo\\":{\\"url\\":\\"g\\"},'
    + '\\"paymentMethodHeader\\":\\"WiZink Classic Plus\\",\\"paymentMethodCardArtInfo\\":{\\"url\\":\\"w\\"},\\"paymentMethodNumber\\":{\\"prefix\\":\\"****\\",\\"lastDigits\\":\\"4321\\"}';
  const rec = extractDetailFields(`<script>self.__next_f.push([1,"x${pm}y"])</script>`, cfg);
  assert.equal(rec.paymentMethod, 'WiZink Classic Plus'); // the card, NOT "Cheque regalo de Amazon"
  assert.equal(rec.paymentLast4, '4321');
});

test('Amazon PDF: 2-step popover → invoice.pdf resolves to a real PDF blob', async () => {
  const doc = { internalId: '111-2222222-3333333' };
  const blob = await fetchPdf(AMAZON, AUTH, doc, amazonNet(POPOVER_WITH));
  const text = await blob.text();
  assert.ok(text.startsWith('%PDF'), 'expected a real PDF, got: ' + text.slice(0, 12));
});

test('Amazon PDF: a popover with no Factura link → metadata-only (fetchPdf rejects)', async () => {
  const doc = { internalId: '444-5555555-6666666' };
  await assert.rejects(() => fetchPdf(AMAZON, AUTH, doc, amazonNet(POPOVER_NONE)), /no document/);
});

test('Amazon guard: a resolved off-domain document URL is rejected (same-registrable-domain boundary)', async () => {
  // Clone the adapter with a permissive linkMatch so a spoofed ABSOLUTE off-domain URL is captured —
  // the runtime's same-domain guard (not the regex) must then reject it before fetching.
  const adapter = JSON.parse(JSON.stringify(AMAZON));
  adapter.api.pdf.resolve.linkMatch = 'href="([^"]+invoice\\.pdf)"';
  const evil = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/your-orders/invoice/popover') return res('<a href="https://evil.example/documents/download/x/invoice.pdf">Factura</a>');
    return res(FAKE_PDF, { blob: new Blob([FAKE_PDF]) });
  };
  await assert.rejects(() => fetchPdf(adapter, AUTH, { internalId: '111-2222222-3333333' }, evil), /host not allowed/);
});
