import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftAdapterFromSamples, listCandidates } from '../src/runtime/infer.js';
import { validateAdapter } from '../src/adapters/validate.js';
import { parseHtmlItems } from '../src/runtime/inventory.js';

// --- SYNTHETIC fixture mirroring the Bip&Drive structure (AJAX that returns an HTML table
// fragment). All values are INVENTED — never real data. Rows carry a date, base/tax/total money
// cells, a PDF <form> (token_csrf + id_factura hidden inputs + a `tipo=PDF` submit) and a public
// invoice number in a title="CI…" attribute.
const bipHtml = `
<table class="tablaAreaPri">
  <tr class="cabecera"><th>Tipo</th><th>Fecha</th><th>Base</th><th>IVA</th><th>Total</th><th>PDF</th><th>Estado</th></tr>
  <tr class="veh_0">
    <td class="text-center"><a href="#" class="hidden-web" onclick="return masInformacion('F0')" id="enlaceMasInfoF1"> Factura </a></td>
    <td class="veh_mat_0"> 30/06/2026 </td>
    <td class="hidden-tablet"> 26,44 € </td>
    <td class="hidden-tablet"> 5,55 € </td>
    <td class="veh_tip_0"> 31,99 € </td>
    <td class="hidden-tablet">
      <form action="" method="POST">
        <input type="hidden" name="token_csrf" value="aaaa1111csrfONE" />
        <input type="text" style="display:none" name="id_factura" value="mDvID0001AAA=" />
        <button type="submit" class="button_link" name="tipo" value="PDF">PDF</button>
      </form>
    </td>
    <td id="table_td_0" title="CI0000000001-0626"> Pagada </td>
  </tr>
  <tr class="veh_1">
    <td class="text-center"><a href="#" class="hidden-web" onclick="return masInformacion('F1')" id="enlaceMasInfoF2"> Factura </a></td>
    <td class="veh_mat_1"> 31/05/2026 </td>
    <td class="hidden-tablet"> 10,00 € </td>
    <td class="hidden-tablet"> 2,10 € </td>
    <td class="veh_tip_1"> 12,10 € </td>
    <td class="hidden-tablet">
      <form action="" method="POST">
        <input type="hidden" name="token_csrf" value="bbbb2222csrfTWO" />
        <input type="text" style="display:none" name="id_factura" value="mDvID0002BBB=" />
        <button type="submit" class="button_link" name="tipo" value="PDF">PDF</button>
      </form>
    </td>
    <td id="table_td_1" title="CI0000000002-0526"> Pagada </td>
  </tr>
</table>`;

const bipSample = {
  url: 'https://areaprivada.bipdrive.com/ajax-mis-facturas', method: 'POST', status: 200,
  reqHeaders: {}, kind: 'html', html: bipHtml, reqBody: 'pagina=1', fromHtml: true,
};

test('infers a from:html list from an AJAX HTML-table fragment (Bip&Drive shape)', () => {
  const r = draftAdapterFromSamples([bipSample], { domain: 'bipdrive.com', pageHost: 'areaprivada.bipdrive.com' });
  assert.ok(r.ok, r.reason);
  const list = r.draft.api.list;
  assert.equal(list.from, 'html');
  assert.equal(list.path, '/ajax-mis-facturas');
  assert.equal(list.method, 'POST');
  assert.equal(list.paging, 'page');
  assert.equal(list.pageParam, 'pagina');
  assert.equal(list.body, 'pagina={pagina}');
  assert.ok(list.rows && list.rows.each, 'a rows.each config is produced');
});

test('the drafted Bip&Drive source passes validateAdapter', () => {
  const r = draftAdapterFromSamples([bipSample], { domain: 'bipdrive.com', pageHost: 'areaprivada.bipdrive.com' });
  const v = validateAdapter(r.draft);
  assert.ok(v.ok, v.errors.join('; '));
  assert.equal(r.draft.auth.mode, 'cookie');
  assert.equal(r.draft.schema, 'invoice@1'); // "Factura" in the markup
});

test('the drafted rows are consumable by parseHtmlItems AS-IS (date/total/number + PDF form fields)', () => {
  const r = draftAdapterFromSamples([bipSample], { domain: 'bipdrive.com', pageHost: 'areaprivada.bipdrive.com' });
  const items = parseHtmlItems(bipHtml, r.draft.api.list.rows);
  assert.equal(items.length, 2);
  assert.equal(items[0].date, '30/06/2026');
  assert.equal(items[0].total, '31,99 €'); // the LAST money cell (total), not base/tax
  assert.equal(items[0].number, 'CI0000000001-0626');
  assert.equal(items[0].token_csrf, 'aaaa1111csrfONE');
  assert.equal(items[0].id_factura, 'mDvID0001AAA=');
  assert.equal(items[1].date, '31/05/2026');
  assert.equal(items[1].total, '12,10 €');
  assert.equal(items[1].id_factura, 'mDvID0002BBB=');
});

test('detects the PDF <form> as a POST with a body templated from the hidden inputs + submit', () => {
  const r = draftAdapterFromSamples([bipSample], { domain: 'bipdrive.com', pageHost: 'areaprivada.bipdrive.com' });
  const pdf = r.draft.api.pdf;
  assert.ok(pdf, 'pdf inferred');
  assert.equal(pdf.method, 'POST');
  assert.equal(pdf.path, '/'); // action="" → current URL → "/"
  assert.equal(pdf.body, 'token_csrf={token_csrf}&id_factura={id_factura}&tipo=PDF');
  // internalId is the public invoice number (unique, human-facing)
  assert.equal(r.draft.fields.internalId, 'number');
  assert.equal(r.draft.fields.date, 'date');
  assert.equal(r.draft.fields.total, 'total');
});

test('the HTML candidate shows up in listCandidates for the picker UI', () => {
  const cands = listCandidates([bipSample]);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].count, 2);
  assert.equal(cands[0].host, 'areaprivada.bipdrive.com');
  assert.ok(cands[0].keys.includes('token_csrf'));
});

// --- Second SYNTHETIC fixture: a plain server-rendered (SSR) page whose rows expose the invoice
// PDF as a simple <a href="…​.pdf">, captured as the MAIN document HTML (kind:'html', GET, no body).
const linkHtml = `
<html><body>
<table>
  <tr><th>Date</th><th>Amount</th><th>Invoice</th></tr>
  <tr>
    <td>2026-06-01</td>
    <td>19,99 €</td>
    <td><a href="/invoices/INV-1001.pdf">Download</a></td>
  </tr>
  <tr>
    <td>2026-05-01</td>
    <td>9,50 €</td>
    <td><a href="/invoices/INV-1002.pdf">Download</a></td>
  </tr>
</table>
</body></html>`;

const linkSample = {
  url: 'https://billing.example.es/account/invoices', method: 'GET', status: 200,
  reqHeaders: {}, kind: 'html', html: linkHtml, fromHtml: true,
};

test('infers a from:html list + GET PDF link from a plain <a href="*.pdf"> table', () => {
  const r = draftAdapterFromSamples([linkSample], { domain: 'example.es', pageHost: 'billing.example.es' });
  assert.ok(r.ok, r.reason);
  assert.equal(r.draft.api.list.from, 'html');
  assert.equal(r.draft.api.list.paging, 'none');
  assert.ok(r.draft.api.list.rows.each);
  assert.equal(r.draft.api.pdf.method, 'GET');
  assert.equal(r.draft.api.pdf.path, '{internalId}');
  assert.equal(r.draft.fields.internalId, 'href');
  assert.ok(validateAdapter(r.draft).ok, validateAdapter(r.draft).errors.join('; '));
});

test('the plain-link drafted rows parse via parseHtmlItems (date/total/href), header row skipped', () => {
  const r = draftAdapterFromSamples([linkSample], { domain: 'example.es', pageHost: 'billing.example.es' });
  const items = parseHtmlItems(linkHtml, r.draft.api.list.rows);
  assert.equal(items.length, 2);
  assert.equal(items[0].date, '2026-06-01');
  assert.equal(items[0].total, '19,99 €');
  assert.equal(items[0].href, '/invoices/INV-1001.pdf');
  assert.equal(items[1].href, '/invoices/INV-1002.pdf');
});

// --- Third SYNTHETIC fixture: a NON-table server-rendered page — each document is a <div> "card" sharing a
// per-row class (no <table>/<li>). All values INVENTED. Exercises the repeated-block (card grid) inference.
const cardHtml = `
<html><body>
<div class="listado-facturas">
  <div class="factura-card">
    <span class="fcol fcol-desc">Peaje mensual</span>
    <span class="fcol fcol-fecha">12/06/2026</span>
    <span class="fcol fcol-importe">18,40 €</span>
    <a class="btn-descargar" href="/docs/f-a1b2c3.pdf">Descargar</a>
  </div>
  <div class="factura-card">
    <span class="fcol fcol-desc">Peaje mensual</span>
    <span class="fcol fcol-fecha">12/05/2026</span>
    <span class="fcol fcol-importe">21,15 €</span>
    <a class="btn-descargar" href="/docs/f-d4e5f6.pdf">Descargar</a>
  </div>
  <div class="factura-card">
    <span class="fcol fcol-desc">Peaje mensual</span>
    <span class="fcol fcol-fecha">12/04/2026</span>
    <span class="fcol fcol-importe">9,90 €</span>
    <a class="btn-descargar" href="/docs/f-90ab12.pdf">Descargar</a>
  </div>
</div>
</body></html>`;
const cardSample = { url: 'https://portal.example.es/mis-facturas', method: 'GET', status: 200, reqHeaders: {}, kind: 'html', html: cardHtml, fromHtml: true };

test('infers a from:html list from a NON-table <div> card grid (repeated-class rows)', () => {
  const r = draftAdapterFromSamples([cardSample], { domain: 'example.es', pageHost: 'portal.example.es' });
  assert.ok(r.ok, r.reason);
  assert.equal(r.draft.api.list.from, 'html');
  assert.ok(r.draft.api.list.rows.row, 'a rows.row (class-split) config is produced'); // not table-based
  assert.equal(r.draft.api.list.rows.row, 'factura-card', 'picks the card class, not an inner column');
  assert.equal(r.draft.api.pdf.method, 'GET');
  assert.equal(r.draft.fields.internalId, 'href');
  assert.ok(validateAdapter(r.draft).ok, validateAdapter(r.draft).errors.join('; '));
});

test('the <div> card rows parse via parseHtmlItems (date/total/href per card)', () => {
  const r = draftAdapterFromSamples([cardSample], { domain: 'example.es', pageHost: 'portal.example.es' });
  const items = parseHtmlItems(cardHtml, r.draft.api.list.rows);
  assert.equal(items.length, 3);
  assert.equal(items[0].date, '12/06/2026');
  assert.equal(items[0].total, '18,40 €');
  assert.equal(items[0].href, '/docs/f-a1b2c3.pdf');
  assert.equal(items[2].href, '/docs/f-90ab12.pdf');
});

// --- Fourth SYNTHETIC fixture: a page with TWO tables (the "wrong" bigger one + the invoices one). All
// values INVENTED. The user must be able to pick the second table; each table is its own candidate, scoped
// to its class so the runtime doesn't merge sibling rows.
const twoTablesHtml = `
<html><body>
<h2>Vehículos</h2>
<table class="tabla-vehiculos">
  <tr><th>Matrícula</th><th>Alta</th></tr>
  <tr><td>1234-ABC</td><td>01/01/2025</td></tr>
  <tr><td>5678-DEF</td><td>02/02/2025</td></tr>
  <tr><td>9012-GHI</td><td>03/03/2025</td></tr>
  <tr><td>3456-JKL</td><td>04/04/2025</td></tr>
</table>
<h2>Facturas</h2>
<table class="tabla-facturas">
  <tr><th>Fecha</th><th>Importe</th><th>PDF</th></tr>
  <tr><td>12/06/2026</td><td>18,40 €</td><td><a href="/f/a1b2.pdf">PDF</a></td></tr>
  <tr><td>12/05/2026</td><td>21,15 €</td><td><a href="/f/c3d4.pdf">PDF</a></td></tr>
</table>
</body></html>`;
const twoSample = { url: 'https://portal.example.es/area', method: 'GET', status: 200, reqHeaders: {}, kind: 'html', html: twoTablesHtml, fromHtml: true };

test('a page with TWO tables offers BOTH as candidates (biggest is only the default)', () => {
  const cands = listCandidates([twoSample]);
  assert.equal(cands.length, 2, 'both tables are selectable candidates');
  assert.equal(cands[0].count, 4); // vehículos (4 rows) is bigger → the auto-picked default
  assert.ok(cands.some((c) => c.keys.includes('total')), 'the facturas table is offered too');
});

test('picking the OTHER (invoices) table drafts it, scoped to its class (no sibling-row bleed)', () => {
  const cands = listCandidates([twoSample]);
  const facturas = cands.find((c) => c.keys.includes('total'));
  assert.ok(facturas);
  const r = draftAdapterFromSamples([twoSample], { domain: 'example.es', pageHost: 'portal.example.es' }, { key: facturas.key });
  assert.ok(r.ok, r.reason);
  assert.equal(r.draft.api.list.rows.within, 'tabla-facturas'); // scoped to the chosen table
  const items = parseHtmlItems(twoTablesHtml, r.draft.api.list.rows); // run against the WHOLE page
  assert.equal(items.length, 2, 'only the invoices table rows — the vehicle table is excluded');
  assert.equal(items[0].date, '12/06/2026');
  assert.equal(items[0].total, '18,40 €');
  assert.equal(items[0].href, '/f/a1b2.pdf');
});

// Regression: a JSON sample and an HTML sample together — both candidates are offered, JSON path
// still works unchanged.
test('HTML inference coexists with JSON inference (regression)', () => {
  const json = { url: 'https://api.x.es/orders?page=1', method: 'GET', status: 200,
    reqHeaders: { authorization: 'bearer eyJx' }, json: { items: [{ orderId: 'O1', createdAt: '2026-01-01', totalEur: 9 }] } };
  const cands = listCandidates([json, bipSample]);
  assert.equal(cands.length, 2);
  const jsonDraft = draftAdapterFromSamples([json], { domain: 'x.es', pageHost: 'www.x.es' });
  assert.equal(jsonDraft.draft.api.list.itemsPath, 'items'); // JSON path intact
});
