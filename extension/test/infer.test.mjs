import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftAdapterFromSamples, draftStreamsFromSamples, draftWithGroups, listCandidates, matchCandidates } from '../src/runtime/infer.js';
import { validateAdapter } from '../src/adapters/validate.js';

const carrefourSamples = [
  { url: 'https://pro.api.carrefour.es/md-purchasesAccount-v1/purchases?from=2023&to=2026&count=50', method: 'GET', status: 200,
    reqHeaders: { authorization: 'bearer eyJx', 'x-xsrf-token': 'a', 'x-csrf-token': 'b', requestorigin: 'web', 'content-type': 'application/json' },
    json: { purchases: [
      { purchaseId: 'P1', purchaseDate: '2026-01-02', amount: 12.34, mallName: 'Carrefour Aldaia', purchaseType: 'HYPERMARKET' },
      { purchaseId: 'P2', purchaseDate: '2026-01-05', amount: 5, mallName: 'Carrefour Market', purchaseType: 'SUPERMARKET' },
    ], offsets: { ticketOffset: 2 } } },
  { url: 'https://pro.api.carrefour.es/md-userAccount-v1/profile', method: 'GET', status: 200, reqHeaders: {}, json: { name: 'A' } },
];

test('picks the biggest list, its itemsPath, and a valid draft', () => {
  const r = draftAdapterFromSamples(carrefourSamples, { domain: 'carrefour.es', pageHost: 'www.carrefour.es' });
  assert.ok(r.ok);
  assert.equal(r.itemsPath, 'purchases');
  assert.equal(r.host, 'pro.api.carrefour.es');
  assert.ok(validateAdapter(r.draft).ok);
});

test('guesses field mapping from key names', () => {
  const r = draftAdapterFromSamples(carrefourSamples, { domain: 'carrefour.es', pageHost: 'www.carrefour.es' });
  assert.equal(r.draft.fields.internalId, 'purchaseId');
  assert.equal(r.draft.fields.date, 'purchaseDate');
  assert.equal(r.draft.fields.total, 'amount');
  assert.equal(r.draft.fields.storeName, 'mallName');
});

test('detects offsets pagination', () => {
  const r = draftAdapterFromSamples(carrefourSamples, { domain: 'carrefour.es', pageHost: 'www.carrefour.es' });
  assert.equal(r.draft.api.list.paging, 'offsets');
  assert.equal(r.draft.api.list.offsetsPath, 'offsets');
});

test('auto-detects an SSR embedded list (fromHtml) + a detail with per-item params (Dia-shape)', () => {
  const it = (ticket) => ({ detail_params: { begin: 1780328485000, business: 1, country: 'ES', pos: 2, store: 15500, ticket }, submitted_date: '2026-06-01T15:41:25Z', total_amount: 9.77, store_info: { city: 'Cobeña' } });
  const samples = [
    // The list is embedded in the page's SSR state (Vike) — bridge posts it as a fromHtml sample.
    { url: 'https://www.dia.es/my-account/tickets', method: 'GET', status: 200, reqHeaders: {}, fromHtml: true, json: { INITIAL_STATE: { ticketsList: [it(464414), it(460615)] } } },
    // The detail XHR the user triggered by opening a ticket — id in the path, per-item params in the query.
    { url: 'https://www.dia.es/api/v3/eservice-back/customer/current/tickets/464414?begin=1780328485000&business=1&country=ES&pos=2&store=15500', method: 'GET', status: 200, reqHeaders: {}, json: { header: { code: 464414 }, total_amount: 9.77 } },
  ];
  const { ok, draft } = draftAdapterFromSamples(samples, { domain: 'dia.es', pageHost: 'www.dia.es' });
  assert.ok(ok);
  assert.equal(draft.api.list.from, 'html'); // read from embedded page state, not an XHR
  assert.equal(draft.api.list.itemsPath, 'INITIAL_STATE.ticketsList');
  assert.equal(draft.fields.internalId, 'detail_params.ticket');
  assert.equal(draft.api.detail.path,
    '/api/v3/eservice-back/customer/current/tickets/{internalId}?begin={detail_params.begin}&business={detail_params.business}&country={detail_params.country}&pos={detail_params.pos}&store={detail_params.store}');
});

test('detects cursor pagination via a nextCursor field', () => {
  const s = [{ url: 'https://api.x.es/tx', method: 'GET', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { transactions: [{ id: '1', valueDate: '2026-01-01', amount: 1 }], paging: { nextCursor: 'c2' } } }];
  const r = draftAdapterFromSamples(s, { domain: 'x.es', pageHost: 'www.x.es' });
  assert.equal(r.draft.api.list.paging, 'cursor');
  assert.equal(r.draft.api.list.nextPath, 'paging.nextCursor');
});

// A POST/GraphQL list: the SPA sends the query in the request BODY (Ikea's purchase-history GraphQL).
// The draft must reproduce it faithfully — method + body + content-type — not silently draft a GET.
test('drafts a POST/GraphQL list preserving method, body and content-type (Ikea-shape)', () => {
  const body = JSON.stringify({ operationName: 'FullHistory', variables: { skip: 0, take: -1 }, query: 'query FullHistory($skip: Int!, $take: Int!) { historyData(skip: $skip, take: $take) { historicalPurchases { id } } }' });
  const s = [{ url: 'https://order.ikea.com/purchase-history/graphql', method: 'POST', status: 200,
    reqHeaders: { authorization: 'bearer eyJz' }, reqBody: body,
    json: { data: { historyData: { historicalPurchases: [
      { id: 'X1', dateAndTime: { date: '2026-01-02' }, storeName: 'IKEA', totalCost: { value: '12.34' } },
      { id: 'X2', dateAndTime: { date: '2026-02-02' }, storeName: 'IKEA', totalCost: { value: '5' } },
    ] } } } }];
  const r = draftAdapterFromSamples(s, { domain: 'ikea.com', pageHost: 'www.ikea.com' });
  assert.ok(r.ok);
  assert.equal(r.draft.api.list.method, 'POST');
  assert.equal(r.draft.api.list.body, body);
  assert.equal(r.draft.api.list.contentType, 'application/json'); // body-shape detected (no content-type header captured)
  assert.equal(r.draft.api.list.itemsPath, 'data.historyData.historicalPurchases');
  assert.equal(r.draft.fields.internalId, 'id');
  assert.ok(validateAdapter(r.draft).ok);
});

// A form-urlencoded POST list (no JSON body) → content-type falls back to form encoding.
test('drafts a form-encoded POST list with the right content-type', () => {
  const s = [{ url: 'https://www.bank.es/movimientos', method: 'POST', status: 200,
    reqHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, reqBody: 'from=2026-01-01&to=2026-06-01',
    json: { movements: [{ id: 'M1', fecha: '2026-01-02', importe: 3 }] } }];
  const r = draftAdapterFromSamples(s, { domain: 'bank.es', pageHost: 'www.bank.es' });
  assert.equal(r.draft.api.list.method, 'POST');
  assert.equal(r.draft.api.list.body, 'from=2026-01-01&to=2026-06-01');
  assert.equal(r.draft.api.list.contentType, 'application/x-www-form-urlencoded');
});

// A CSRF prelude: the POST list body carries a token that was scraped from a page the SPA loaded
// first (WiZink's securityToken). The draft must emit api.csrf (so the runtime fetches a FRESH token
// each run) and template the body value as {csrf} instead of freezing the captured one.
test('infers a CSRF prelude from a body token found in a captured HTML page (WiZink-shape)', () => {
  const tok = 'AB12cd34EF56gh78ZZ';
  const html = `<!doctype html><html><body><form><input type="hidden" name="securityToken" value="${tok}"></form></body></html>`;
  const body = `operation=list&securityToken=${tok}&from=2026-01-01`;
  const samples = [
    { url: 'https://www.wizink.es/clientes/posicion-global', method: 'GET', status: 200, reqHeaders: {}, kind: 'html', html, fromHtml: true },
    { url: 'https://www.wizink.es/clientes/movimientos', method: 'POST', status: 200,
      reqHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, reqBody: body,
      json: { movements: [{ id: 'M1', fecha: '2026-01-02', importe: 3 }] } },
  ];
  const r = draftAdapterFromSamples(samples, { domain: 'wizink.es', pageHost: 'www.wizink.es' });
  assert.ok(r.ok);
  assert.ok(r.draft.api.csrf, 'emits a csrf prelude');
  assert.equal(r.draft.api.csrf.path, '/clientes/posicion-global');
  const m = new RegExp(r.draft.api.csrf.match).exec(html); // the regex re-extracts the token
  assert.equal(m && m[1], tok);
  assert.ok(r.draft.api.list.body.includes('{csrf}'), 'body token templated as {csrf}');
  assert.ok(!r.draft.api.list.body.includes(tok), 'the frozen token is gone');
  assert.ok(validateAdapter(r.draft).ok);
});

// No csrf prelude when no captured HTML page contains the body token (don't invent one → avoids an
// unnecessary, possibly-failing prelude fetch at runtime).
test('does not invent a CSRF prelude when the token is not found in any HTML page', () => {
  const body = 'operation=list&securityToken=AB12cd34EF56gh78ZZ&from=2026-01-01';
  const samples = [{ url: 'https://www.wizink.es/clientes/movimientos', method: 'POST', status: 200,
    reqHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, reqBody: body,
    json: { movements: [{ id: 'M1', fecha: '2026-01-02', importe: 3 }] } }];
  const r = draftAdapterFromSamples(samples, { domain: 'wizink.es', pageHost: 'www.wizink.es' });
  assert.ok(!r.draft.api.csrf);
});

// Multi-stream: the user browsed TWO distinct lists on the same domain (Leroy Merlin: tickets +
// orders). Draft them as one source with streams[] — a shared base (auth/host) and a per-stream
// api.list + fields — instead of forcing two separate sources.
test('drafts multiple same-domain lists as streams[] (Leroy Merlin-shape)', () => {
  const samples = [
    { url: 'https://www.leroymerlin.es/services/receipts?page=0&size=10', method: 'GET', status: 200, reqHeaders: {},
      json: { receipts: [{ id: 'R1', date: '2026-01-01', totalPrice: 5, store: { storeName: 'LM Aldaia' } }] } },
    { url: 'https://www.leroymerlin.es/backend/v2/orders', method: 'GET', status: 200, reqHeaders: {},
      json: { orders: [{ orderPartNumber: 'O1', createdAt: '2026-02-01', totalAmount: 9 }] } },
  ];
  const keys = listCandidates(samples).map((c) => c.key);
  const r = draftStreamsFromSamples(samples, { domain: 'leroymerlin.es', pageHost: 'www.leroymerlin.es' }, keys);
  assert.ok(r.ok);
  assert.equal(r.draft.streams.length, 2);
  assert.ok(!r.draft.api.list, 'the base carries no top-level list (each stream has its own)');
  assert.equal(r.draft.api.host, 'https://www.leroymerlin.es');
  const byId = Object.fromEntries(r.draft.streams.map((s) => [s.id, s]));
  assert.ok(byId['receipts'] && byId['orders'], 'stream ids derived from the list paths');
  assert.equal(byId['receipts'].api.list.itemsPath, 'receipts');
  assert.equal(byId['orders'].api.list.itemsPath, 'orders');
  assert.equal(byId['receipts'].fields.internalId, 'id');
  assert.ok(validateAdapter(r.draft).ok);
});

// With a single list, it degrades to the normal single-stream draft (no streams[]).
test('draftStreamsFromSamples falls back to a single-stream draft for one list', () => {
  const s = [{ url: 'https://api.x.es/orders', method: 'GET', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { items: [{ orderId: 'O1', createdAt: '2026-01-01', totalEur: 9 }] } }];
  const r = draftStreamsFromSamples(s, { domain: 'x.es', pageHost: 'www.x.es' });
  assert.ok(r.ok);
  assert.ok(!r.draft.streams, 'no streams[] for a single list');
  assert.ok(r.draft.api.list);
});

// auth.context: a stable personal id (a DNI) appears in the path of several requests. Capture it as
// {ctx.*} from another request and template the list path with it, instead of freezing one user's id.
test('infers auth.context from a stable id shared across request URLs (Caixabank-shape)', () => {
  const dni = '12345678Z';
  const samples = [
    { url: `https://clientes.caixabankconsumer.com/cpc/v1.0/portalCliente/posicionGlobal/es/${dni}`, method: 'GET', status: 200,
      reqHeaders: { authorization: 'Bearer eyJp' }, json: { accounts: [{ id: 'A1' }] } },
    { url: `https://clientes.caixabankconsumer.com/cpc/v1.0/crm365/${dni}/movimientos`, method: 'GET', status: 200,
      reqHeaders: { authorization: 'Bearer eyJp' }, json: { movements: [{ id: 'M1', fecha: '2026-01-01', importe: 3 }] } },
  ];
  const listKey = listCandidates(samples).find((c) => c.url.includes('movimientos')).key;
  const r = draftAdapterFromSamples(samples, { domain: 'caixabankconsumer.com', pageHost: 'clientes.caixabankconsumer.com' }, { key: listKey });
  assert.ok(r.ok);
  assert.ok(r.draft.auth.context && r.draft.auth.context.length, 'emits auth.context');
  const c = r.draft.auth.context[0];
  assert.equal(c.name, 'dni'); // DNI-shaped
  assert.equal(c.from, 'url');
  const m = new RegExp(c.match).exec(`/cpc/v1.0/portalCliente/posicionGlobal/es/${dni}`);
  assert.equal(m && m[1], dni); // the regex re-extracts the id
  assert.ok(r.draft.api.list.path.includes('{ctx.dni}'), 'list path templated with {ctx.dni}');
  assert.ok(!r.draft.api.list.path.includes(dni), 'the frozen id is gone from the list path');
});

// Don't invent auth.context for a value that appears in only ONE request (e.g. a per-document id) —
// there'd be no separate request to capture it from.
test('does not infer auth.context from a one-off id', () => {
  const s = [{ url: 'https://api.shop.es/v1/orders/ORD12345678', method: 'GET', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { items: [{ orderId: 'O1', createdAt: '2026-01-01', totalEur: 9 }] } }];
  const r = draftAdapterFromSamples(s, { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.ok(!r.draft.auth.context);
});

// Body-based pagination: some APIs page in the POST body, not the query string. Template the page/
// offset field so the runtime's pager fills it.
test('infers page pagination inside a form-encoded POST body', () => {
  const s = [{ url: 'https://www.bank.es/mov', method: 'POST', status: 200,
    reqHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, reqBody: 'page=0&size=10',
    json: { movements: [{ id: 'M1', fecha: '2026-01-01', importe: 3 }] } }];
  const r = draftAdapterFromSamples(s, { domain: 'bank.es', pageHost: 'www.bank.es' });
  assert.equal(r.draft.api.list.paging, 'page');
  assert.equal(r.draft.api.list.pageParam, 'page');
  assert.ok(r.draft.api.list.body.includes('page={page}'));
  assert.ok(r.draft.api.list.body.includes('size=10')); // other fields preserved
});

test('infers offset pagination inside a JSON POST body (GraphQL variables.skip)', () => {
  const body = JSON.stringify({ operationName: 'H', variables: { skip: 0, take: 10 }, query: 'query H($skip:Int){list(skip:$skip){id}}' });
  const s = [{ url: 'https://order.ikea.com/graphql', method: 'POST', status: 200, reqHeaders: {}, reqBody: body,
    json: { data: { list: [{ id: 'X1', date: '2026-01-01', total: 5 }] } } }];
  const r = draftAdapterFromSamples(s, { domain: 'ikea.com', pageHost: 'www.ikea.com' });
  assert.equal(r.draft.api.list.paging, 'offset');
  assert.equal(r.draft.api.list.offsetParam, 'skip');
  assert.ok(r.draft.api.list.body.includes('{skip}'));
  const filled = r.draft.api.list.body.replace('{skip}', '20'); // fills to valid JSON
  assert.doesNotThrow(() => JSON.parse(filled));
  assert.equal(JSON.parse(filled).variables.skip, 20);
});

// A year-partitioned list (Amazon /your-orders?timeFilter=year-YYYY): the URL filters by year with an
// optional within-year startIndex → paging:'years' so the runtime scans years back.
test('infers a year-partitioned pager (Amazon /your-orders)', () => {
  const s = [{ url: 'https://www.amazon.es/your-orders/orders?timeFilter=year-2026&startIndex=0', method: 'GET', status: 200, reqHeaders: {}, fromHtml: true,
    json: { orders: [{ orderId: '123-4567890-1234567', date: '2026-01-01' }] } }];
  const r = draftAdapterFromSamples(s, { domain: 'amazon.es', pageHost: 'www.amazon.es' });
  assert.equal(r.draft.api.list.paging, 'years');
  assert.equal(r.draft.api.list.years.param, 'timeFilter');
  assert.equal(r.draft.api.list.years.format, 'year-{y}');
  assert.equal(r.draft.api.list.years.startParam, 'startIndex');
  assert.ok(!(r.draft.api.list.params && 'timeFilter' in r.draft.api.list.params), 'year param not frozen into static params');
  assert.ok(validateAdapter(r.draft).ok);
});

// A plain 4-digit value in an unrelated param is NOT a year pager (avoid false positives).
test('does not treat an arbitrary 4-digit id as a year pager', () => {
  const s = [{ url: 'https://api.shop.es/orders?storeId=2026', method: 'GET', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { items: [{ orderId: 'O1', createdAt: '2026-01-01', totalEur: 9 }] } }];
  const r = draftAdapterFromSamples(s, { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.notEqual(r.draft.api.list.paging, 'years');
});

// Groups (multi-account): the user marks a captured list as their accounts/cards; the doc list is
// fetched per account. Build api.groups from that list and template the doc list with {group.id}.
test('drafts api.groups from an accounts list and templates the doc list with {group.id}', () => {
  const acct = '00811234';
  const samples = [
    { url: 'https://www.bank.es/api/accounts', method: 'GET', status: 200, reqHeaders: { authorization: 'eyJ' },
      json: { accounts: [{ accountId: acct, alias: 'Nómina', iban: 'ES9121000418450200051332' }] } },
    { url: `https://www.bank.es/api/accounts/${acct}/movements`, method: 'GET', status: 200, reqHeaders: { authorization: 'eyJ' },
      json: { movements: [{ id: 'M1', date: '2026-01-01', amount: 3 }] } },
  ];
  const cands = listCandidates(samples);
  const listKey = cands.find((c) => c.url.includes('movements')).key;
  const groupsKey = cands.find((c) => c.url.endsWith('/api/accounts')).key;
  const r = draftWithGroups(samples, { domain: 'bank.es', pageHost: 'www.bank.es' }, listKey, groupsKey);
  assert.ok(r.ok);
  assert.ok(r.draft.api.groups, 'has api.groups');
  assert.equal(r.draft.api.groups.itemsPath, 'accounts');
  assert.equal(r.draft.api.groups.fields.id, 'accountId');
  assert.equal(r.draft.api.groups.fields.name, 'alias');
  assert.ok((r.draft.api.groups.mask || []).length, 'the IBAN-like field is masked');
  assert.ok(r.draft.api.list.path.includes('{group.id}'), 'doc list templated with {group.id}');
  assert.ok(!r.draft.api.list.path.includes(acct), 'the frozen account id is gone');
  assert.ok(validateAdapter(r.draft).ok);
});

// Without a groups selection it stays a normal single-list draft.
test('draftWithGroups without a groups key is a plain draft', () => {
  const s = [{ url: 'https://api.x.es/orders', method: 'GET', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { items: [{ orderId: 'O1', createdAt: '2026-01-01', totalEur: 9 }] } }];
  const r = draftWithGroups(s, { domain: 'x.es', pageHost: 'www.x.es' }, null, null);
  assert.ok(r.ok);
  assert.ok(!r.draft.api.groups);
});

// TDD: page pagination is inferred when the request carries a `page` query param and the response
// has neither a cursor nor an offsets object.
test('detects page pagination from a `page` query param', () => {
  const s = [{ url: 'https://api.shop.es/v1/orders?page=1&count=20', method: 'GET', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { items: [{ orderId: 'O1', createdAt: '2026-01-01', totalEur: 9 }] } }];
  const r = draftAdapterFromSamples(s, { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.list.paging, 'page');
  assert.equal(r.draft.api.list.pageParam, 'page');
});

// Learn pagination from the ACTUAL pages the user browsed (not just single-sample signals).
test('learns page pagination from several captured pages', () => {
  const p = (n) => ({ url: `https://api.shop.es/orders?page=${n}`, status: 200, reqHeaders: {}, json: { items: [{ id: 'O' + n }] } });
  const r = draftAdapterFromSamples([p(1), p(2), p(3)], { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.list.paging, 'page');
  assert.equal(r.draft.api.list.pageParam, 'page');
});

test('learns OFFSET pagination (param `from`, step = page size) from several pages', () => {
  const p = (off, ids) => ({ url: `https://api.shop.es/orders?from=${off}&limit=2`, status: 200, reqHeaders: {}, json: { items: ids.map((id) => ({ id })) } });
  const r = draftAdapterFromSamples([p(0, ['A', 'B']), p(2, ['C', 'D']), p(4, ['E'])], { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.list.paging, 'offset');
  assert.equal(r.draft.api.list.offsetParam, 'from');
  assert.equal(r.draft.api.list.offsetStep, 2);
  assert.equal(r.draft.api.list.offsetStart, 0);
  assert.ok(!('from' in (r.draft.api.list.params || {}))); // the offset param is stripped (start fresh)
  assert.equal(r.draft.api.list.params.limit, '2');        // page-size param stays
});

test('offset pagination starts at 0 even if page 1 (from=0) was not captured', () => {
  const p = (off) => ({ url: `https://api.shop.es/o?from=${off}&size=9`, status: 200, reqHeaders: {}, json: { items: [{ id: 'x' + off }] } });
  const r = draftAdapterFromSamples([p(9), p(18), p(27)], { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.list.paging, 'offset');
  assert.equal(r.draft.api.list.offsetStart, 0); // not 9 — start from the beginning
  assert.equal(r.draft.api.list.offsetStep, 9);
});

test('de oficio: carries app headers + per-page/per-item Referer into the draft', () => {
  const uuid = 'abc-uuid-1';
  const samples = [
    { url: 'https://www.x.es/ajax/list?from=0', status: 200, reqHeaders: { 'dkt-ecom-origin': 'web', uzlc: '00000000000000-0000-0000-0000-000000000000-00000000000000000000-000000000000000000000000FAKE', authorization: 'eyJ' }, json: { items: [{ id: uuid, total: 5 }] } },
    { url: 'https://www.x.es/ajax/order?associationId=' + uuid, status: 200, reqHeaders: { 'dkt-ecom-origin': 'web' }, json: { id: uuid, lines: [] } },
  ];
  const domTexts = [
    { url: 'https://www.x.es/account/order?transactionId=' + uuid, text: 'Pedido' },
    { url: 'https://www.x.es/account/list?page=2', text: 'Mis pedidos' },
  ];
  const r = draftAdapterFromSamples(samples, { domain: 'x.es', pageHost: 'www.x.es', domTexts });
  assert.equal(r.draft.api.list.headers['dkt-ecom-origin'], 'web');           // app header, not auth
  assert.ok(!('uzlc' in r.draft.api.list.headers), 'ephemeral anti-bot token not hardcoded');
  assert.equal(r.draft.api.list.referer, 'https://www.x.es/account/list?page={page}');
  assert.equal(r.draft.api.detail.headers['dkt-ecom-origin'], 'web');
  assert.equal(r.draft.api.detail.referer, 'https://www.x.es/account/order?transactionId={internalId}');
});

test('learns cursor pagination: page 1 has no token, page 2 carries the response token', () => {
  const s = [
    { url: 'https://api.shop.es/tx', status: 200, reqHeaders: {}, json: { items: [{ id: '1' }], paging: { next: 'TOK2' } } },
    { url: 'https://api.shop.es/tx?cur=TOK2', status: 200, reqHeaders: {}, json: { items: [{ id: '2' }], paging: { next: 'TOK3' } } },
  ];
  const r = draftAdapterFromSamples(s, { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.list.paging, 'cursor');
  assert.equal(r.draft.api.list.cursorParam, 'cur');
  assert.equal(r.draft.api.list.nextPath, 'paging.next');
});

// Search-by-value: a non-technical user types a ticket no. / amount to pick the right list.
const twoLists = [
  { url: 'https://api.shop.es/v1/orders?page=1', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { items: [{ orderId: 'A-100', total: 12.5 }, { orderId: 'A-101', total: 7 }] } },
  { url: 'https://api.shop.es/v1/recommendations', status: 200, reqHeaders: {},
    json: { products: [{ sku: 'X1' }, { sku: 'X2' }, { sku: 'X3' }, { sku: 'X4' }] } },
];

test('matchCandidates finds the list containing a recognised value', () => {
  const m = matchCandidates(twoLists, 'A-101');
  assert.equal(m.length, 1);
  assert.equal(m[0].itemsPath, 'items');
  // biggest list is recommendations, but search picks orders by value
  assert.notEqual(m[0].key, listCandidates(twoLists)[0].key);
});

test('matchCandidates matches an amount too', () => {
  assert.equal(matchCandidates(twoLists, '12.5')[0].itemsPath, 'items');
  assert.equal(matchCandidates(twoLists, 'nope').length, 0);
});

test('pages of the same list dedupe to one candidate', () => {
  const paged = [
    { url: 'https://api.shop.es/v1/orders?page=1', status: 200, reqHeaders: {}, json: { items: [{ orderId: 'A-1' }] } },
    { url: 'https://api.shop.es/v1/orders?page=2', status: 200, reqHeaders: {}, json: { items: [{ orderId: 'A-2' }, { orderId: 'A-3' }] } },
  ];
  const cands = listCandidates(paged);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].count, 3); // aggregated across pages: A-1 + A-2 + A-3
  assert.equal(cands[0].pages, 2); // two pages captured
});

test('infers a JSON detail endpoint (preferred document) from a per-order detail response', () => {
  const samples = [
    { url: 'https://api.shop.es/v1/orders?page=1', status: 200, reqHeaders: { authorization: 'eyJ' },
      json: { items: [{ id: 'ORD-7', total: 5 }, { id: 'ORD-8', total: 9 }] } },
    { url: 'https://api.shop.es/v1/orders/ORD-8', status: 200, reqHeaders: { authorization: 'eyJ' },
      json: { id: 'ORD-8', lines: [{ sku: 'a' }], total: 9 } },
  ];
  const r = draftAdapterFromSamples(samples, { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.ok(r.draft.api.detail, 'detail inferred');
  assert.equal(r.draft.api.detail.path, '/v1/orders/{internalId}');
  assert.ok(!r.draft.api.pdf, 'no PDF when detail present');
});

test('internalId is the internal id used in the URL, not the human-facing receipt number', () => {
  const samples = [
    { url: 'https://api.shop.es/v1/orders', status: 200, reqHeaders: { authorization: 'eyJ' },
      json: { items: [{ number: 'F-2026-0007', ref: 'abc-123-def', total: 5 }] } },
    { url: 'https://api.shop.es/v1/orders/abc-123-def', status: 200, reqHeaders: { authorization: 'eyJ' },
      json: { ref: 'abc-123-def', number: 'F-2026-0007', lines: [] } },
  ];
  const r = draftAdapterFromSamples(samples, { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.detail.path, '/v1/orders/{internalId}');
  assert.equal(r.draft.fields.internalId, 'ref'); // the URL id, not 'number' (the visible receipt no.)
});

test('rendered page text distinguishes the public (visible) number from the internal id', () => {
  const samples = [{ url: 'https://api.shop.es/v1/orders', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { items: [{ id: 'u-abc-999', receiptId: 'R-2026-42', total: 5 }] } }];
  const domTexts = ['Mis pedidos\nPedido R-2026-42 · 5€']; // the user sees the receipt no., not the uuid
  const r = draftAdapterFromSamples(samples, { domain: 'shop.es', pageHost: 'www.shop.es', domTexts });
  assert.equal(r.draft.fields.internalId, 'id');        // internal (not rendered)
  assert.equal(r.draft.fields.number, 'receiptId');     // public (rendered)
});

test('detail endpoint from a navigated (SSR) page with the id in a query param', () => {
  const uuid = '47dc2ad6-7b3f-4238-8ed9-5888c399a347';
  const samples = [{ url: 'https://www.decathlon.es/api/orders', status: 200, reqHeaders: {},
    json: { items: [{ transactionId: uuid, number: '12345', total: 9 }] } }];
  const domTexts = [{ url: `https://www.decathlon.es/es/account/orderTracking?transactionId=${uuid}&type=store`, text: 'Mis pedidos\nPedido 12345 · 9€' }];
  const r = draftAdapterFromSamples(samples, { domain: 'decathlon.es', pageHost: 'www.decathlon.es', domTexts });
  assert.ok(r.draft.api.detail, 'detail inferred from the navigated page');
  assert.equal(r.draft.api.detail.path, '/es/account/orderTracking?transactionId={internalId}&type=store');
  assert.equal(r.draft.fields.internalId, 'transactionId'); // internal uuid (in the URL, not rendered)
  assert.equal(r.draft.fields.number, 'number');             // 12345 is rendered → public
});

test('infers a POST-generated PDF (body templated by id) from captured assets', () => {
  const samples = [{ url: 'https://api.shop.es/v1/orders', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { items: [{ id: 'ORD-8', total: 9 }] } }];
  const assets = [{ url: 'https://api.shop.es/v1/pdf', method: 'POST', reqType: 'application/json', reqBody: '{"orderId":"ORD-8"}', status: 200 }];
  const r = draftAdapterFromSamples(samples, { domain: 'shop.es', pageHost: 'www.shop.es', assets });
  assert.equal(r.draft.api.pdf.method, 'POST');
  assert.equal(r.draft.api.pdf.body, '{"orderId":"{internalId}"}');
});

test('pagination cursor/page is stripped from captured params (starts from the beginning)', () => {
  const cursor = [{ url: 'https://api.shop.es/v1/tx?cursor=PAGE3TOKEN&limit=50', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { transactions: [{ id: 't9', valueDate: '2026-03-09', amount: -3 }], paging: { nextCursor: 'c4' } } }];
  const r = draftAdapterFromSamples(cursor, { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.list.paging, 'cursor');
  assert.ok(!('cursor' in (r.draft.api.list.params || {})), 'cursor param must be stripped');
  assert.equal(r.draft.api.list.params.limit, '50'); // page-size param stays
});
