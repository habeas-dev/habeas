import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import carrefour from '../src/adapters/carrefour-es.js';
import mart from './fixtures/examplemart-es.js';
import bank from './fixtures/examplebank-es.js';
import energy from './fixtures/exampleenergy-es.js';
import { listInventory, listGroups, fetchDocument, fetchDetail, fetchPdf, normalizeDate, normalizeAmount, parseHtmlItems, artifactKinds, fetchArtifact, endOfMonth } from '../src/runtime/inventory.js';
import { sinkAcceptsArtifact } from '../src/sinks/format.js';

const auth = { authorization: 'bearer eyJx' };
function stub(pages) {
  let i = 0; const urls = [];
  globalThis.fetch = async (u) => { urls.push(u); return { ok: true, json: async () => pages[Math.min(i++, pages.length - 1)], text: async () => '' }; };
  return urls;
}

test('carrefour offsets paging: query is byte-identical to the historical shape', async () => {
  const urls = stub([
    { purchases: [{ purchaseId: 'P1', purchaseDate: '2026-01-02', amount: 12.34, mallName: 'S', mallAddress: 'A', purchaseType: 'HYPERMARKET' }], offsets: { ticketOffset: 1 } },
    { purchases: [], offsets: {} },
  ]);
  const docs = await listInventory(carrefour, auth);
  const qs = urls[0].split('?')[1].replace(/from=[^&]+&to=[^&]+/, 'from=X&to=X');
  assert.equal(qs, 'from=X&to=X&count=50&ticketOffset=0&atgfOffset=0&atgnfOffset=0&currentTickets=0&currentAtgfOrders=0&currentAtgnfOrders=0');
  assert.deepEqual(docs[0].record, { internalId: 'P1', date: '2026-01-02', total: 12.34, currency: 'EUR', category: 'grocery', store: { name: 'S', address: 'A' }, source: undefined, type: 'HYPERMARKET' });
});

test('page paging stops on a partial page', async () => {
  stub([
    { data: { items: [{ id: 'a', purchasedAt: '2026-02-01', amount: 10, store: { name: 'S1' }, channel: 'STORE' }, { id: 'b', purchasedAt: '2026-02-02', amount: 20, store: { name: 'S2' }, channel: 'ONLINE' }] } },
    { data: { items: [{ id: 'c', purchasedAt: '2026-02-03', amount: 30, store: { name: 'S3' }, channel: 'STORE' }] } },
  ]);
  mart.api.list.params.count = 2;
  const docs = await listInventory(mart, auth);
  assert.equal(docs.length, 3);
  assert.deepEqual(docs.map((d) => d.category).sort(), ['grocery', 'grocery', 'retail']);
});

test('html list: parses items from a server-rendered table (from:html), incl. row links', async () => {
  const html = `<table><tr><th>Date</th><th>Amount</th><th></th></tr>
    <tr><td>2026-01-02</td><td>10.00</td><td><a href="/receipts/A1.pdf">PDF</a></td></tr>
    <tr><td>2026-01-05</td><td>7.50</td><td><a href="/receipts/A2.pdf">PDF</a></td></tr></table>`;
  globalThis.fetch = async () => ({ ok: true, text: async () => html, json: async () => { throw new Error('not json'); } });
  const adapter = { api: { host: 'https://x.es', list: { path: '/control_panel/settings/receipts', from: 'html', paging: 'none' } }, fields: { internalId: 'href', date: 'Date', total: 'Amount' }, schema: 'invoice@1' };
  const docs = await listInventory(adapter, { byPath: {}, merged: {} });
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map((d) => d.internalId).sort(), ['/receipts/A1.pdf', '/receipts/A2.pdf']); // id from the row's link
  assert.ok(docs.every((d) => d.date && d.total));
});

test('normalizeDate: American textual + Spanish + numeric → ISO', () => {
  assert.equal(normalizeDate('October 22, 2021'), '2021-10-22');
  assert.equal(normalizeDate('Oct 5 2021'), '2021-10-05');
  assert.equal(normalizeDate('22 de octubre de 2021'), '2021-10-22');
  assert.equal(normalizeDate('2021-10-22'), '2021-10-22');
  assert.equal(normalizeDate('2021-10-22T10:00:00Z'), '2021-10-22');
  assert.equal(normalizeDate('22/10/2021'), '2021-10-22');
  assert.equal(normalizeDate(''), '');
  assert.equal(normalizeDate('not a date'), 'not a date');
});

test('mapDoc normalizes a textual date field to ISO (and sorts by it)', async () => {
  const items = [{ id: 'a', d: 'October 22, 2021', t: 5 }, { id: 'b', d: 'January 3, 2022', t: 9 }];
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ items }) });
  const adapter = { api: { host: 'https://x.es', list: { path: '/l', paging: 'none', itemsPath: 'items' } }, fields: { internalId: 'id', date: 'd', total: 't' }, schema: 'invoice@1' };
  const docs = await listInventory(adapter, { byPath: {}, merged: {} });
  assert.equal(docs[0].date, '2022-01-03'); // newest first (ISO sort works)
  assert.equal(docs[1].date, '2021-10-22');
});

test('detail.as:html fetches the print page and inlines its CSS + images (self-contained)', async () => {
  const page = '<html><head><link rel="stylesheet" href="/css/print.css"></head><body><h1>Receipt</h1><img src="/logo.png"></body></html>';
  globalThis.fetch = async (u) => {
    if (u.endsWith('/css/print.css')) return { ok: true, text: async () => 'body{color:red}' };
    if (u.endsWith('/logo.png')) return { ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) };
    return { ok: true, text: async () => page };
  };
  const adapter = { name: 'Hover', api: { host: 'https://www.hover.com', detail: { path: '/control_panel/receipts/{internalId}', as: 'html' } }, fields: { internalId: 'id' }, schema: 'receipt@1' };
  const { blob, ext, via } = await fetchDocument(adapter, { byPath: {}, merged: {} }, { internalId: 'abc' });
  assert.equal(ext, 'html'); assert.equal(via, 'page');
  const html = await blob.text();
  assert.match(html, /<style>body\{color:red\}<\/style>/);        // CSS inlined
  assert.match(html, /data:image\/png;base64,/);                   // image inlined as data URI
  assert.match(html, /<base href="https:\/\/www\.hover\.com\/">/); // base added for anything else
});

test('artifacts: a source produces BOTH data (JSON) and a document (rendered HTML); sink chooses', async () => {
  const render = async () => '<html><body><h1>Invoice X</h1></body></html>';
  globalThis.fetch = async (u) => (String(u).includes('/api/') ? { ok: true, text: async () => JSON.stringify({ id: 'X', total: 5 }) } : { ok: true, text: async () => '' });
  const adapter = { name: 'Hover', api: { host: 'https://h.es', list: { path: '/l', paging: 'none', itemsPath: 'items' }, detail: { path: '/api/receipts/{internalId}' }, document: { path: '/receipts/{internalId}', as: 'render' } }, fields: { internalId: 'id' }, schema: 'receipt@1' };
  assert.deepEqual(artifactKinds(adapter).map((k) => k.kind).sort(), ['data', 'document']);
  const data = await fetchArtifact(adapter, {}, { internalId: 'X' }, null, render, 'data');
  assert.equal(data.ext, 'json'); assert.match(await data.blob.text(), /"id"/);
  const doc = await fetchArtifact(adapter, {}, { internalId: 'X' }, null, render, 'document');
  assert.equal(doc.ext, 'html'); assert.match(await doc.blob.text(), /Invoice X/);
  // sink filtering: default = both; accepts.artifacts narrows.
  assert.ok(sinkAcceptsArtifact({}, 'data') && sinkAcceptsArtifact({}, 'document'));
  const s = { accepts: { artifacts: ['document'] } };
  assert.ok(sinkAcceptsArtifact(s, 'document') && !sinkAcceptsArtifact(s, 'data'));
});

test('detail.as:render captures the FINAL rendered DOM (via injected render) + inlines assets', async () => {
  // The SPA shell fetched statically is empty; the injected render returns the DOM AFTER the app ran.
  const rendered = '<html><head><link rel="stylesheet" href="/app.css"></head><body><h1>Invoice INV-9</h1><div>Total 18.99</div></body></html>';
  const render = async (url, opts) => { render.calledWith = { url, opts }; return rendered; };
  globalThis.fetch = async (u) => (u.endsWith('/app.css') ? { ok: true, text: async () => '.inv{}' } : { ok: true, text: async () => '' });
  const adapter = { name: 'Hover', api: { host: 'https://www.hover.com', detail: { path: '/control_panel/receipts/{internalId}', as: 'render', waitFor: '.receipt' } }, fields: { internalId: 'invoice' }, schema: 'receipt@1' };
  const { blob, ext, via } = await fetchDocument(adapter, {}, { internalId: 'abc' }, null, render);
  assert.equal(ext, 'html'); assert.equal(via, 'render');
  assert.equal(render.calledWith.url, 'https://www.hover.com/control_panel/receipts/abc');
  assert.equal(render.calledWith.opts.waitFor, '.receipt');
  const html = await blob.text();
  assert.match(html, /Invoice INV-9/);            // the real rendered content
  assert.match(html, /<style>\.inv\{\}<\/style>/); // its CSS inlined → self-contained
});

test('detail.as:invoice renders a clean printable HTML invoice from the JSON detail', async () => {
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ invoice: 'INV-9', date: '2021-10-22', total: '18.99', lines: [{ item: 'domain', price: '18.99' }] }) });
  const adapter = { name: 'Hover', api: { host: 'https://x.es', detail: { path: '/r/{internalId}', as: 'invoice' } }, fields: { internalId: 'invoice' }, schema: 'receipt@1' };
  const doc = { internalId: 'INV-9', record: { number: 'INV-9', date: '2021-10-22', total: '18.99', currency: 'EUR' } };
  const { blob, ext, via } = await fetchDocument(adapter, {}, doc);
  assert.equal(ext, 'html'); assert.equal(via, 'invoice');
  const html = await blob.text();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /INV-9/); assert.match(html, /18\.99/); assert.match(html, /Hover/);
});

test('html list: extracts React data-props bootstrap JSON (hover.com style)', async () => {
  const props = { initialData: { path: '/', data: { receipts: [
    { id: 'r-1', date: '2026-01-02', total: '18.99', num: 'INV-1' },
    { id: 'r-2', date: '2026-02-02', total: '17.99', num: 'INV-2' },
  ] } }, feature_flags: [] };
  const html = `<div id='app' data-props='${JSON.stringify(props).replace(/"/g, '&quot;')}'></div>`;
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  const adapter = { api: { host: 'https://www.hover.com', list: { path: '/control_panel/settings/receipts', from: 'html', itemsPath: 'initialData.data.receipts', paging: 'none' } }, fields: { internalId: 'id', date: 'date', total: 'total', number: 'num' }, schema: 'invoice@1' };
  const docs = await listInventory(adapter, { byPath: {}, merged: {} });
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map((d) => d.internalId).sort(), ['r-1', 'r-2']);
  assert.ok(docs.every((d) => d.date && d.total));
});

test('offset paging advances by offsetStep until an empty page (Decathlon-style: 9/page)', async () => {
  const adapter = { api: { host: 'https://x.es', list: { path: '/orders', paging: 'offset', itemsPath: 'items', offsetParam: 'from', offsetStart: 0, offsetStep: 9 } }, fields: { internalId: 'id', date: 'd' }, schema: 'receipt@1' };
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(u);
    const from = Number(new URL(u).searchParams.get('from'));
    const ids = from < 18 ? [from, from + 1].map((n) => ({ id: 'R' + n, d: '2026-01-01' })) : []; // pages until offset 18 → empty
    return { ok: true, json: async () => ({ items: ids }), text: async () => '' };
  };
  const docs = await listInventory(adapter, { authorization: 'eyJ' });
  assert.equal(docs.length, 4);                                  // 2 + 2 + 0 → 4 docs (paginated past page 1!)
  assert.deepEqual(urls.map((u) => new URL(u).searchParams.get('from')), ['0', '9', '18']);
});

test('runtime resolves offset paging from offsetParam when `paging` is blank', async () => {
  const adapter = { api: { host: 'https://x.es', list: { path: '/o', paging: '', itemsPath: 'items', offsetParam: 'from', offsetStart: 0, offsetStep: 2 } }, fields: { internalId: 'id', date: 'd' }, schema: 'receipt@1' };
  globalThis.fetch = async (u) => { const from = Number(new URL(u).searchParams.get('from')); const ids = from < 4 ? [from, from + 1].map((n) => ({ id: 'R' + n, d: '2026-01-01' })) : []; return { ok: true, json: async () => ({ items: ids }) }; };
  const docs = await listInventory(adapter, { authorization: 'eyJ' });
  assert.equal(docs.length, 4); // paginated despite paging:'' (offsetParam drives it)
});

test('api.groups: lists transactions per account, tagging each with its account ({group.*})', async () => {
  const accounts = { accounts: [{ resourceId: 'A1', iban: 'ES11', alias: 'Nómina' }, { resourceId: 'A2', iban: 'ES22', alias: 'Ahorro' }] };
  const tx = {
    A1: { transactions: { booked: [{ transactionId: 't1', bookingDate: '2026-01-02', transactionAmount: { amount: -10, currency: 'EUR' } }] } },
    A2: { transactions: { booked: [{ transactionId: 't2', bookingDate: '2026-01-03', transactionAmount: { amount: 20, currency: 'EUR' } }] } },
  };
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    if (String(u).endsWith('/accounts')) return { ok: true, json: async () => accounts };
    const m = String(u).match(/accounts\/(A\d)\/transactions/);
    return { ok: true, json: async () => tx[m[1]] };
  };
  const adapter = {
    api: {
      host: 'https://bank.es',
      groups: { path: '/accounts', itemsPath: 'accounts', fields: { id: 'resourceId', iban: 'iban', name: 'alias' } },
      list: { path: '/accounts/{group.id}/transactions', paging: 'none', itemsPath: 'transactions.booked' },
    },
    fields: { internalId: '{group.id}-{transactionId}', date: 'bookingDate', total: 'transactionAmount.amount', account: '{group.iban}', accountName: '{group.name}' },
    auth: { mode: 'cookie' }, schema: 'transaction@1',
  };
  const docs = await listInventory(adapter, { byPath: {}, merged: {} });
  assert.equal(docs.length, 2);
  const byId = Object.fromEntries(docs.map((d) => [d.internalId, d]));
  assert.equal(byId['A1-t1'].account, 'ES11'); assert.equal(byId['A1-t1'].accountName, 'Nómina');
  assert.equal(byId['A2-t2'].account, 'ES22'); assert.equal(byId['A2-t2'].total, 20);
  assert.ok(urls.includes('https://bank.es/accounts/A1/transactions')); // per-account URL templated
  assert.ok(urls.includes('https://bank.es/accounts/A2/transactions'));
  assert.equal(byId['A1-t1']._group.iban, 'ES11'); // record carries its group
});

test('document templates {group.*}+{csrf} and honors pdf.ext (WiZink Excel statement)', async () => {
  let url = '';
  globalThis.fetch = async (u) => { url = String(u); return { ok: true, status: 200, blob: async () => new Blob(['x']) }; };
  const adapter = { api: { host: 'https://b.es', pdf: { path: '/dl?acc={group.accountNumber}&date={statementDate}&t={csrf}', method: 'GET', ext: 'xls' } }, fields: {}, schema: 'invoice@1' };
  const doc = { internalId: '1', _raw: { statementDate: '2026-06-23' }, _group: { accountNumber: 'ACC1' } };
  assert.deepEqual(artifactKinds(adapter, doc).map((k) => k.ext), ['xls']); // custom ext
  const r = await fetchArtifact(adapter, { byPath: {}, merged: {}, __csrf: 'TOK' }, doc, globalThis.fetch, null, 'document');
  assert.equal(r.ext, 'xls');
  assert.equal(url, 'https://b.es/dl?acc=ACC1&date=2026-06-23&t=TOK'); // {group.*}, {field}, {csrf} all filled
});

test('AEM/WiZink pipeline: CSRF prelude → groups POST (regex each) → per-card movements POST → parse', async () => {
  const csrfPage = '<input type="hidden" name="securityToken" value="TOK12345678" />';
  const groupsHtml = "<a onclick=\"goToCardDetail('ACC1', 'CARD1', 'today');\">c1</a>"
    + "<a onclick=\"goToCardDetail('ACC1', 'CARD1', 'today');\">dup</a>" // duplicate → deduped
    + "<a onclick=\"goToCardDetail('ACC2', 'CARD2', 'today');\">c2</a>";
  const movHtml = (n) => `<div class="movement-item"><h4>SHOP ${n}</h4><span class="movement-date">30 JUN</span><span class="movement-amount">10,00 €</span></div>`;
  const seen = { csrfInBody: null };
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); const pn = u.searchParams.get('pagename') || '';
    if ((init.body || '').includes('{csrf}')) throw new Error('unfilled {csrf}');
    if (init.method === 'POST') seen.csrfInBody = ((init.body || '').match(/securityToken=([A-Z0-9]+)/) || [])[1];
    let body = '';
    if (u.pathname === '/csrf') body = csrfPage;
    else if (pn.endsWith('NewGlobalPosition')) body = groupsHtml;
    else if (pn.endsWith('NewToday')) body = movHtml(init.body.match(/accountNumber=(ACC\d)/)[1]);
    return { ok: true, status: 200, text: async () => body };
  };
  const adapter = {
    api: {
      host: 'https://b.es',
      csrf: { path: '/csrf', match: "securityToken['\"]?\\s*(?:value=|:)\\s*['\"]([A-Z0-9]{6,})" },
      groups: { from: 'html', path: '/s', method: 'POST', params: { pagename: 'X/NewGlobalPosition' }, body: 'securityToken={csrf}',
        rows: { each: "goToCardDetail\\('([^']+)',\\s*'([^']+)'", fields: { accountNumber: { group: 1 }, cardNumber: { group: 2 } } },
        fields: { id: 'accountNumber', accountNumber: 'accountNumber', cardNumber: 'cardNumber' } },
      list: { from: 'html', path: '/s', method: 'POST', paging: 'none', params: { pagename: 'X/NewToday' },
        body: 'accountNumber={group.accountNumber}&cardNumber={group.cardNumber}&securityToken={csrf}',
        rows: { row: 'movement-item', require: 'date', fields: { concept: { tag: 'h4' }, date: { sel: 'movement-date' }, amount: { sel: 'movement-amount' } } } },
    },
    fields: { internalId: '{group.accountNumber}|{date}|{concept}', date: 'date', total: 'amount', counterparty: 'concept', account: '{group.accountNumber}' },
    auth: { mode: 'cookie' }, currency: 'EUR', schema: 'transaction@1',
  };
  const groups = await listGroups(adapter, { byPath: {}, merged: {} });
  assert.deepEqual(groups.map((g) => g.accountNumber), ['ACC1', 'ACC2']); // deduped
  const docs = await listInventory(adapter, { byPath: {}, merged: {} });
  assert.equal(seen.csrfInBody, 'TOK12345678'); // prelude token injected into POST bodies
  assert.equal(docs.length, 2); // one movement per card
  assert.equal(docs[0].total, 10); assert.match(docs[0].date, /^\d{4}-06-30$/);
  assert.deepEqual(new Set(docs.map((d) => d.account)), new Set(['ACC1', 'ACC2']));
});

test('parseHtmlItems extracts records from repeated HTML blocks (WiZink AEM movements shape)', () => {
  const html = '<ul>'
    + '<li><div class="movement-item mcc-5734"><h4>ACME REST</h4><span class="card-number-masked">*4321</span>'
    + '<span class="movement-date">30 JUN</span><span class="movement-amount">21,00 €</span>'
    + '<div class="movement-options"><a data-category="RESTAURACION">x</a></div></div></li>'
    + '<li><div class="movement-item mcc-9999"><h4>FOO SHOP</h4><span class="card-number-masked">*4321</span>'
    + '<span class="movement-date">01 JUL</span><span class="movement-amount">1.234,56 €</span>'
    + '<div class="movement-options"><a data-category="OCIO">y</a></div></div></li>'
    + '<li><div class="movement-item summary"><h4>Tu forma de pago</h4></div></li></ul>'; // header row → dropped by require
  const cfg = { row: 'movement-item', require: 'date', fields: { concept: { tag: 'h4' }, card: { sel: 'card-number-masked' }, date: { sel: 'movement-date' }, total: { sel: 'movement-amount' }, category: { attr: 'data-category' }, mcc: { re: 'mcc-(\\d+)' } } };
  const items = parseHtmlItems(html, cfg);
  assert.equal(items.length, 2); // the no-date summary row is dropped
  assert.deepEqual(items[0], { concept: 'ACME REST', card: '*4321', date: '30 JUN', total: '21,00 €', category: 'RESTAURACION', mcc: '5734' });
  assert.equal(items[1].total, '1.234,56 €');
});

test('parseHtmlItems collapses whitespace so a bounded `each` reaches its target (WiZink card label)', () => {
  const html = "<a onclick=\"goToCardDetail('ACC1', 'CARD1', 'today');\"\n\n       class=\"card-link\">\n   <div class=\"c-card__summary\">\n     <span class=\"card-product-name\"><span class=\"sr-only\">Nombre: </span>WiZink Oro</span>\n     <span class=\"card-security-code\"><span class=\"sr-only\">Nº: </span> **** **** **** 8765 </span></div></a>";
  const cfg = { each: "goToCardDetail\\('([^']+)',\\s*'([^']+)'[\\s\\S]{0,180}?c-card__summary[\\s\\S]{0,150}?card-product-name[^>]*>(?:<span[^>]*>[^<]*</span>)?\\s*([^<]+?)\\s*</span>[\\s\\S]{0,200}?card-security-code[^>]*>(?:<span[^>]*>[^<]*</span>)?\\s*([^<]*\\d{4})", fields: { accountNumber: { group: 1 }, name: { group: 3 }, mask: { group: 4 } } };
  const items = parseHtmlItems(html, cfg);
  assert.equal(items.length, 1);
  assert.equal(items[0].accountNumber, 'ACC1');
  assert.equal(items[0].name, 'WiZink Oro');
  assert.equal(items[0].mask.replace(/\s+/g, ' ').trim(), '**** **** **** 8765');
});

test('normalizeAmount parses Spanish/EUR amounts; normalizeDate infers year for "DD MON"', () => {
  assert.equal(normalizeAmount('21,00 €'), 21);
  assert.equal(normalizeAmount('1.234,56 €'), 1234.56);
  assert.equal(normalizeAmount('-5,00'), -5);
  assert.equal(normalizeAmount('5,00-'), -5);
  assert.equal(normalizeAmount(42), 42);
  assert.match(normalizeDate('30 JUN'), /^\d{4}-06-30$/); // day/month fixed; year inferred
  assert.match(normalizeDate('1 ene'), /^\d{4}-01-01$/);
});

test('list.range + window "90d" requests only the last ~90 days (WiZink: avoids extra auth)', async () => {
  let url = '';
  globalThis.fetch = async (u) => { url = String(u); return { ok: true, json: async () => ({ items: [] }) }; };
  const adapter = { api: { host: 'https://b.es', list: { path: '/tx', paging: 'none', itemsPath: 'items', range: { from: 'from', to: 'to', format: 'date' }, window: '90d' } }, fields: { internalId: 'id' }, auth: { mode: 'cookie' }, schema: 'transaction@1' };
  await listInventory(adapter, { byPath: {}, merged: {} });
  const u = new URL(url);
  const days = (new Date(u.searchParams.get('to')) - new Date(u.searchParams.get('from'))) / 86400000;
  assert.ok(days >= 89 && days <= 91, 'window ~90 days, got ' + days);
  assert.match(u.searchParams.get('from'), /^\d{4}-\d{2}-\d{2}$/); // format:'date'
});

test('listGroups enumerates the accounts with their mapped fields', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ accounts: [{ resourceId: 'A1', iban: 'ES11', alias: 'Nómina' }] }) });
  const adapter = { api: { host: 'https://bank.es', groups: { path: '/accounts', itemsPath: 'accounts', fields: { id: 'resourceId', iban: 'iban', name: 'alias' } }, list: { path: '/x' } }, fields: {}, auth: { mode: 'cookie' }, schema: 'transaction@1' };
  const groups = await listGroups(adapter, { byPath: {}, merged: {} });
  assert.equal(groups.length, 1);
  assert.deepEqual({ id: groups[0].id, iban: groups[0].iban, name: groups[0].name }, { id: 'A1', iban: 'ES11', name: 'Nómina' });
});

test('artifactKinds drops a document a doc cannot fill (Dia ticket with no invoice) — no error', () => {
  const adapter = { api: { detail: { path: '/t/{internalId}' }, pdf: { path: '/t/{ticket_unique_code}/invoice?inv={invoices.0}' } }, fields: {}, schema: 'receipt@1' };
  const withInv = { internalId: '1', _raw: { ticket_unique_code: 'ES1', invoices: ['A'] } };
  const noInv = { internalId: '2', _raw: { ticket_unique_code: 'ES2', invoices: [] } };
  assert.deepEqual(artifactKinds(adapter).map((k) => k.kind), ['data', 'document']); // adapter-level: both possible
  assert.deepEqual(artifactKinds(adapter, withInv).map((k) => k.kind), ['data', 'document']);
  assert.deepEqual(artifactKinds(adapter, noInv).map((k) => k.kind), ['data']); // no invoice → no document artifact
});

test('itemsPath `a[].b` flattens a list nested one-per-group (PepeEnergy periods[].invoices)', async () => {
  // Two periods; one holds two invoices (a grouped bill) → 3 items total after flattening.
  const data = { periods: [
    { code: 'P1', invoices: [{ id: 1, code: 'E-1', invoice_date: '2026-06-30', total_amount: 40, contract_id: 900 }] },
    { code: 'P2', invoices: [
      { id: 2, code: 'E-2', invoice_date: '2026-05-31', total_amount: 30, contract_id: 900 },
      { id: 3, code: 'E-3', invoice_date: '2026-05-15', total_amount: 5, contract_id: 900 },
    ] },
    'chart-label', // a non-object period element must be skipped, not crash
  ] };
  const adapter = { id: 'x', api: { host: 'https://x.es', list: { path: '/inv', itemsPath: 'periods[].invoices', paging: 'none' } }, fields: { internalId: 'id', number: 'code', date: 'invoice_date', total: 'total_amount' }, schema: 'invoice@1' };
  const net = async () => ({ ok: true, status: 200, sentHeaders: [], text: async () => JSON.stringify(data), json: async () => data });
  const docs = await listInventory(adapter, {}, net, {});
  assert.equal(docs.length, 3, 'all invoices across periods');
  assert.deepEqual(docs.map((d) => d.internalId).sort(), [1, 2, 3]);
  assert.equal(docs.find((d) => d.internalId === 1).record.total, 40);
});

test('endOfMonth: a month value → that month\'s last day (Pagatelia invoice emission date)', () => {
  assert.equal(endOfMonth('07/2026'), '2026-07-31');   // MM/YYYY
  assert.equal(endOfMonth('24/07/2026'), '2026-07-31'); // DD/MM/YYYY → month's last day (not the day shown)
  assert.equal(endOfMonth('2026-02'), '2026-02-28');   // YYYY-MM (non-leap Feb)
  assert.equal(endOfMonth('2024-02'), '2024-02-29');   // leap Feb
  assert.equal(endOfMonth('julio de 2026'), '2026-07-31'); // Spanish month name
  assert.equal(endOfMonth('Julio 2026'), '2026-07-31');    // capitalized, no "de"
  assert.equal(endOfMonth(''), '');
});

test('a rows field can carry endOfMonth (extractField applies it)', () => {
  const html = '<table class="grid"><tr class="row"><td class="billDate">24/07/2026</td><td class="billNumber">FRA-1</td></tr></table>';
  const items = parseHtmlItems(html, { within: 'grid', each: '<tr\\b[^>]*>[\\s\\S]*?</tr>', fields: { date: { sel: 'billDate', endOfMonth: true }, number: { sel: 'billNumber' } } });
  assert.equal(items.length, 1);
  assert.equal(items[0].date, '2026-07-31'); // snapped to the month's last day
  assert.equal(items[0].number, 'FRA-1');    // other fields unaffected
});

test('synthetic monthly statement: a store re-download derives {year}/{month} from the record date', async () => {
  // extracto-integrado shape: PDF path templated by {year}/{month}; no keepRaw, so a re-downloaded doc has no _raw.
  const adapter = { api: { host: 'https://ing.example', pdf: { path: '/statement?year={year}&month={month}', ext: 'pdf' } }, fields: {}, schema: 'invoice@1' };
  const stored = { internalId: '2026-06', record: { date: '2026-06-30', number: '2026-06', description: 'Extracto 2026-06' } }; // from the store: record only, no _raw
  // artifactKinds must still see a document (previously {year}/{month} were unresolvable → PDF silently dropped).
  assert.deepEqual(artifactKinds(adapter, stored).map((k) => k.kind), ['document']);
  let url = '';
  globalThis.fetch = async (u) => { url = u; return { ok: true, status: 200, blob: async () => new Blob(['%PDF']), text: async () => '' }; };
  await fetchPdf(adapter, {}, stored);
  assert.equal(url, 'https://ing.example/statement?year=2026&month=6'); // derived, not literal {year}/{month}
});

test('a source can override the request Accept via headers (pdf + detail)', async () => {
  let acc = '';
  globalThis.fetch = async (u, i) => { acc = (i.headers || {}).accept; return { ok: true, status: 200, text: async () => '{}', blob: async () => new Blob(['%PDF']) }; };
  const pdfAd = { api: { host: 'https://x.es', pdf: { path: '/p/{internalId}', headers: { accept: 'application/pdf' } } }, fields: {}, schema: 'receipt@1' };
  await fetchPdf(pdfAd, { byPath: {}, merged: {} }, 'id1');
  assert.equal(acc, 'application/pdf'); // definition overrides the */* default
  const detAd = { api: { host: 'https://x.es', detail: { path: '/d/{internalId}', headers: { accept: 'application/xml' } } }, fields: {}, schema: 'receipt@1' };
  await fetchDetail(detAd, { byPath: {}, merged: {} }, 'id1');
  assert.equal(acc, 'application/xml'); // detail.headers overrides the default too
});

test('fetchPdf templates {field.path} and bails cleanly when a field is missing', async () => {
  let url = '';
  globalThis.fetch = async (u) => { url = String(u); return { ok: true, status: 200, blob: async () => new Blob(['%PDF']) }; };
  const adapter = { api: { host: 'https://x.es', pdf: { path: '/t/{ticket_unique_code}/invoice?inv={invoices.0}' } }, fields: {}, schema: 'receipt@1' };
  await fetchPdf(adapter, { byPath: {}, merged: {} }, { internalId: '1', _raw: { ticket_unique_code: 'ES1', invoices: ['A'] } });
  assert.equal(url, 'https://x.es/t/ES1/invoice?inv=A');
  await assert.rejects(fetchPdf(adapter, { byPath: {}, merged: {} }, { internalId: '2', _raw: { ticket_unique_code: 'ES2', invoices: [] } }), /no document/);
});

test('detail path templates {field.path} from the list item (Dia-style multi-param detail)', async () => {
  let url = '';
  globalThis.fetch = async (u) => { url = String(u); return { ok: true, text: async () => JSON.stringify({ id: 't1' }) }; };
  const adapter = { api: { host: 'https://x.es', detail: { path: '/tickets/{internalId}?begin={dp.begin}&pos={dp.pos}&c={dp.country}' } }, fields: { internalId: 'id' }, schema: 'receipt@1' };
  const doc = { internalId: 't1', _raw: { id: 't1', dp: { begin: 1780328485000, pos: 2, country: 'ES' } } };
  await fetchDetail(adapter, { byPath: {}, merged: {} }, doc);
  assert.equal(url, 'https://x.es/tickets/t1?begin=1780328485000&pos=2&c=ES'); // per-item params, not just {internalId}
});

test('embeddedObjects finds the right <script type=application/json> among several (itemsPath into it)', async () => {
  const html = '<script type="application/ld+json">{"@type":"Org"}</script>'
    + '<script id="vike_pageContext" type="application/json">{"INITIAL_STATE":{"ticketsList":[{"id":"A"},{"id":"B"}]}}</script>';
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  const adapter = { api: { host: 'https://x.es', list: { path: '/l', from: 'html', paging: 'none', itemsPath: 'INITIAL_STATE.ticketsList' } }, fields: { internalId: 'id' }, schema: 'receipt@1' };
  const docs = await listInventory(adapter, { byPath: {}, merged: {} });
  assert.deepEqual(docs.map((d) => d.internalId).sort(), ['A', 'B']);
});

test('fetchDetail sends static detail.headers and templates the id in the query', async () => {
  const adapter = { api: { host: 'https://www.decathlon.es', detail: { path: '/web-engage/ajax/order?associationId={internalId}&orderManager=cube', headers: { 'dkt-ecom-origin': 'web-navigate-front', 'dkt-ecom-country': 'ES' } } }, fields: { internalId: 'associationId' }, schema: 'receipt@1' };
  let seen;
  globalThis.fetch = async (u, init) => { seen = { u, headers: init.headers, cred: init.credentials }; return { ok: true, text: async () => JSON.stringify({ associationId: 'UUID-1', total: 5 }) }; };
  const { via } = await fetchDetail(adapter, {}, 'UUID-1');
  assert.equal(via, 'json');
  assert.equal(seen.headers['dkt-ecom-origin'], 'web-navigate-front');
  assert.equal(seen.headers['dkt-ecom-country'], 'ES');
  assert.equal(seen.cred, 'include');                       // cookie session rides along
  assert.ok(seen.u.includes('associationId=UUID-1'), seen.u);
});

test('fetchDocument from:list returns the raw list item as JSON (no network)', async () => {
  const adapter = { api: { host: 'https://x.es', list: { path: '/l' }, detail: { from: 'list' } }, fields: { internalId: 'id' }, schema: 'receipt@1' };
  let called = false; globalThis.fetch = async () => { called = true; return { ok: true, text: async () => '' }; };
  const doc = { internalId: 'A', _raw: { id: 'A', total: 9, lines: [{ sku: 'x' }] } };
  const { blob, via } = await fetchDocument(adapter, {}, doc);
  assert.equal(via, 'list');
  assert.equal(called, false); // no request — the item is already in hand
  assert.deepEqual(JSON.parse(await blob.text()), { id: 'A', total: 9, lines: [{ sku: 'x' }] });
});

test('cursor paging follows nextPath and emits transaction records', async () => {
  stub([
    { transactions: [{ id: 't1', valueDate: '2026-03-01', amount: -12.5, concept: 'Coffee', merchant: { name: 'Bar' }, direction: 'debit', operationType: 'PURCHASE' }], paging: { nextCursor: 'c2' } },
    { transactions: [{ id: 't2', valueDate: '2026-03-02', amount: -99, concept: 'ATM', merchant: { name: 'ATM' }, direction: 'debit', operationType: 'WITHDRAWAL' }], paging: { nextCursor: null } },
  ]);
  const docs = await listInventory(bank, auth);
  assert.equal(docs.length, 2);
  const r = docs.find((d) => d.internalId === 't1').record;
  assert.equal(r.amount, -12.5);
  assert.equal(r.counterparty, 'Bar');
  assert.equal(r.direction, 'debit');
});

test('none paging + invoice schema coerces numbers and nests issuer', async () => {
  stub([{ invoices: [{ invoiceNumber: 'F-1', issueDate: '2026-01-15', amountDue: '45.60', supplierName: 'E', supplyAddress: 'X', invoiceType: 'ELECTRICITY', supplyType: 'ELECTRICITY' }] }]);
  const docs = await listInventory(energy, auth);
  assert.equal(docs.length, 1);
  assert.deepEqual(docs[0].record, { internalId: 'F-1', date: '2026-01-15', total: 45.6, currency: 'EUR', category: 'utility', issuer: { name: 'E', address: 'X' }, number: 'F-1', type: 'ELECTRICITY', source: undefined });
});

test('fetchPdf throws cheaply for a source with no PDF', async () => {
  const { fetchPdf } = await import('../src/runtime/inventory.js');
  await assert.rejects(() => fetchPdf(bank, auth, 't1'), /no PDF/);
});

test('documentExt prefers GET pdf, then json detail, then POST pdf', async () => {
  const { documentExt } = await import('../src/runtime/inventory.js');
  assert.equal(documentExt({ api: { pdf: { path: '/p/{internalId}' } } }), 'pdf');
  assert.equal(documentExt({ api: { detail: { path: '/d/{internalId}' } } }), 'json');
  assert.equal(documentExt({ api: { pdf: { path: '/p', method: 'POST' }, detail: { path: '/d' } } }), 'json');
  assert.equal(documentExt({ api: {} }), null);
});

test('fetchDetail GETs the JSON detail (via=json)', async () => {
  const { fetchDetail } = await import('../src/runtime/inventory.js');
  globalThis.fetch = async (u) => { assert.match(u, /\/orders\/ORD-8$/); return { ok: true, text: async () => '{"id":"ORD-8"}' }; };
  const adapter = { api: { host: 'https://api.shop.es', detail: { path: '/orders/{internalId}' } } };
  const { blob, via } = await fetchDetail(adapter, auth, 'ORD-8');
  assert.equal(via, 'json');
  assert.equal(blob.type, 'application/json');
  assert.equal(await blob.text(), '{"id":"ORD-8"}');
});

test('fetchDetail extracts embedded JSON from a server-rendered page (via=embedded)', async () => {
  const { fetchDetail } = await import('../src/runtime/inventory.js');
  const html = '<html><body><h1>Pedido</h1><script id="__NEXT_DATA__" type="application/json">{"order":{"id":"X","total":9}}</script></body></html>';
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  const adapter = { api: { host: 'https://www.shop.es', detail: { path: '/account/orderTracking?transactionId={internalId}&type=store' } } };
  const { blob, via } = await fetchDetail(adapter, {}, 'X-UUID');
  assert.equal(via, 'embedded');
  assert.equal(JSON.parse(await blob.text()).order.id, 'X');
});

test('detail narrows the embedded app state to just the requested purchase', async () => {
  const { fetchDetail } = await import('../src/runtime/inventory.js');
  const state = { props: { pageProps: {
    orders: [{ id: 'A', total: 1 }, { id: 'B', total: 2 }],           // the WHOLE list (all purchases)
    order: { id: 'B', total: 2, lines: [{ sku: 'x' }], address: 'C/ Y' }, // the one being viewed
  } } };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(state)}</script>`;
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  const adapter = { api: { host: 'https://x.es', detail: { path: '/o?id={internalId}' } } };
  const { blob } = await fetchDetail(adapter, {}, 'B');
  const data = JSON.parse(await blob.text());
  assert.equal(data.id, 'B');                 // only order B
  assert.ok(data.lines && data.address);      // the rich detail
  assert.ok(!('orders' in data));             // NOT the whole state with every purchase
});

test('fetchDetail parses an HTML table (via=table)', async () => {
  const { fetchDetail } = await import('../src/runtime/inventory.js');
  const html = '<table><tr><td>Total</td><td>9,90 €</td></tr><tr><td>Estado</td><td>Entregado</td></tr></table>';
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  const adapter = { api: { host: 'https://www.shop.es', detail: { path: '/d/{internalId}' } } };
  const { blob, via } = await fetchDetail(adapter, {}, 'A');
  assert.equal(via, 'table');
  const data = JSON.parse(await blob.text());
  assert.equal(data.Total, '9,90 €');
  assert.equal(data.Estado, 'Entregado');
});

test('fetchDocument returns json + via for a detail source', async () => {
  const { fetchDocument } = await import('../src/runtime/inventory.js');
  globalThis.fetch = async () => ({ ok: true, text: async () => '{"x":1}' });
  const adapter = { api: { host: 'https://api.shop.es', detail: { path: '/o/{internalId}' } } };
  const doc = await fetchDocument(adapter, auth, 'A');
  assert.equal(doc.ext, 'json');
  assert.equal(doc.via, 'json');
  assert.equal(await doc.blob.text(), '{"x":1}');
});
