import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactString, redactUrl, redactJson, redactBody, redactFrame, redactHeaders, redactHtml, buildHandoff, makeRefs } from '../src/lib/redact.js';

// Fully synthetic, PII-SHAPED values — NEVER copied from any real capture. The redactor must remove
// every one of these from any output.
const NAME = 'Jane Q. Testerson';
const ADDR = '742 Evergreen Terrace, Springfield, 00000';
const EMAIL = 'jane.testerson@example.com';
const PHONE = '+1 555 000 0000';                        // 555 = reserved fictional phone prefix
const IBAN = 'GB00TEST00000000000000';                  // synthetic, not a real IBAN
const CARD = '4111111111111111';                        // universal Visa test card
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5lIn0.abcDEF123-_';
const ORDERID = '1000000000000001';                     // synthetic 16-digit id
const LEAKS = [NAME, 'Jane', 'Testerson', 'Evergreen', 'Springfield', EMAIL, 'example.com', '555', '0000', IBAN, 'GB00', CARD, '411111', JWT, 'eyJ', ORDERID];

function assertClean(obj, ctx) {
  const blob = JSON.stringify(obj);
  for (const leak of LEAKS) assert.ok(!blob.includes(leak), `${ctx}: leaked "${leak}" → ${blob.slice(0, 200)}`);
}

test('redactString classifies each PII type, keeps none of the value', () => {
  assert.equal(redactString(EMAIL), '[email]');
  assert.equal(redactString(JWT), '[jwt]');
  assert.equal(redactString(IBAN), '[iban]');
  assert.equal(redactString(CARD), '[card]');
  assert.equal(redactString('2026-05-24'), '[date]');
  assert.equal(redactString('9,99€'), '[amount:EUR]');
  assert.match(redactString(PHONE), /\[phone\]/);
  assert.equal(redactString(NAME), '[text]');
  assert.equal(redactString(ADDR), '[text]');
  assert.equal(redactString(ORDERID), '[num:16]');
});

test('redactUrl keeps the endpoint template, redacts ids + query values', () => {
  const r = redactUrl(`https://acs.aliexpress.com/h5/mtop.aliexpress.trade.buyer.order.list/1.0/?t=1784173710546&sign=abc&orderId=${ORDERID}`);
  assert.match(r, /h5\/mtop\.aliexpress\.trade\.buyer\.order\.list/);  // api name (structure) survives
  assert.match(r, /t=\[v\]/);                                          // param names kept, values gone
  assertClean(r, 'url');
  assert.equal(redactUrl(`https://x.com/tickets/${ORDERID}/pdf`), 'https://x.com/tickets/[id]/pdf');
});

test('redactUrl keeps non-PII enum/date query values, redacts ids/tokens/PII', () => {
  const r = redactUrl(`https://x.com/api/movements?paginationType=CLOSE&monthFilter=202506&from=2026-06-01&accountNumber=12345678&sig=aB3xaB3xaB3xaB3xaB3xaB3x&email=${EMAIL}`);
  assert.match(r, /paginationType=CLOSE/);   // enum value kept (needed to author pagination)
  assert.match(r, /monthFilter=202506/);     // short numeric filter kept
  assert.match(r, /from=2026-06-01/);        // date kept
  assert.match(r, /accountNumber=\[v\]/);    // long numeric id → redacted
  assert.match(r, /sig=\[v\]/);              // opaque token → redacted
  assert.match(r, /email=\[v\]/);            // PII → redacted
  assertClean(r, 'url-params');
});

test('redactString keeps short system/operation codes, redacts longer numbers', () => {
  assert.equal(redactString('0006'), '0006');   // e.g. card-purchase operation code
  assert.equal(redactString('0019'), '0019');   // e.g. transfer operation code
  assert.equal(redactString('1234'), '1234');   // 4-digit center/department code
  assert.equal(redactString('99999'), '[num:5]'); // 5-digit (postcode-length) → still redacted
});

test('handoff correlation: same id → stable [id#N] across path/query/header/field; codes kept; PII not correlated', () => {
  const CID = '123456789012'; // synthetic 12-digit id (client-ish → redacted + correlated)
  const bundle = buildHandoff({
    domain: 'bank.test',
    samples: [{
      url: `https://bank.test/api/payments/${CID}/v3/movements?accountNumber=${CID}&operationType=A`,
      method: 'GET',
      reqHeaders: { 'x-entity': CID, authorization: 'Bearer eyJx.y.z' },
      json: { cards: [{ contractId: CID, opCode: '0006', centerCode: '1234', holder: NAME }] },
    }],
  });
  assertClean(bundle, 'corr');
  const s = bundle.samples[0];
  const tag = s.json.cards[0].contractId;
  assert.match(tag, /^\[id#\d+\]$/);                                   // a client id → correlatable tag
  assert.ok(s.url.includes('/payments/' + tag + '/'), 'path shares the tag');
  assert.ok(s.url.includes('accountNumber=' + tag), 'query shares the tag');
  assert.equal(s.reqHeaders['x-entity'], tag);                         // header shares it → answers "same id?" structurally
  assert.equal(s.reqHeaders.authorization, '[redacted]');              // auth dropped, never correlated
  assert.equal(s.json.cards[0].opCode, '0006');                        // operation code (system) kept
  assert.equal(s.json.cards[0].centerCode, '1234');                    // 4-digit code kept
  assert.equal(s.json.cards[0].holder, '[text]');                      // a name is NOT kept/correlated
  assert.ok(s.url.includes('operationType=A'));                        // enum kept
});

test('redactJson: keeps keys + shape, strips every value (real receipt shape)', () => {
  const receipt = { data: { data: {
    ['pc_om_list_order_' + ORDERID]: { fields: { orderId: ORDERID, orderDateText: '05 may, 2020', totalPriceText: '9,99€', currencyCode: 'EUR', storeName: NAME } },
    deliveryAddress: { contactName: NAME, addressSummaryInfoDisplay: ADDR, fullPhoneNo: PHONE },
    paymentInfo: { cardNo: CARD, methodName: 'Visa' },
    email: EMAIL, token: JWT, iban: IBAN,
  } } };
  const r = redactJson(receipt);
  assertClean(r, 'json');
  // structure preserved: component key prefix kept (id redacted), field names intact
  const inner = r.data.data;
  assert.ok(Object.keys(inner).some((k) => k === 'pc_om_list_order_[id]'), 'component prefix kept, id redacted');
  assert.ok('deliveryAddress' in inner && 'contactName' in inner.deliveryAddress, 'field names preserved');
});

test('redactBody: form-encoded + JSON payloads are redacted', () => {
  assertClean(redactBody(`data=${encodeURIComponent(JSON.stringify({ orderId: ORDERID, name: NAME }))}&sign=abc`), 'body-form');
  assertClean(redactBody(JSON.stringify({ email: EMAIL, iban: IBAN })), 'body-json');
});

test('redactFrame: WS frame with embedded JSON is redacted, framing kept', () => {
  const frame = `sub 12 {"type":"timeline","user":"${NAME}","email":"${EMAIL}","items":[{"id":"${ORDERID}"}]}`;
  const r = redactFrame(frame);
  assert.match(r, /^sub 12 /);           // protocol framing preserved
  assert.match(r, /"type":"\[text\]"/);  // (values redacted)
  assertClean(r, 'frame');
});

test('redactHeaders: token/auth values dropped, names kept', () => {
  const r = redactHeaders({ authorization: 'Bearer ' + JWT, 'x-device-id': 'abc123', 'x-csrf-token': 'secret', 'content-type': 'application/json' });
  assert.equal(r.authorization, '[redacted]');
  assert.equal(r['x-csrf-token'], '[redacted]');
  assert.equal(r['content-type'], 'application/json');   // safe config header kept
  assertClean(r, 'headers');
});

test('redactHtml: table shape + class attrs kept, cell text blanked', () => {
  const html = `<table><tr class="row_1"><td class="name">${NAME}</td><td><a href="/pdf/${ORDERID}">${IBAN}</a></td></tr></table>`;
  const r = redactHtml(html);
  assert.match(r, /<table><tr class="row_1"><td class="name">/); // structure + class survive
  assertClean(r, 'html');                                         // href id + text gone
});

test('buildHandoff: complete bundle is PII-free and excludes auth/dom', () => {
  const bundle = buildHandoff({
    domain: 'aliexpress.com',
    samples: [
      { url: `https://acs.aliexpress.com/h5/mtop.x/1.0/?orderId=${ORDERID}`, method: 'POST', status: 200, reqHeaders: { authorization: JWT, 'content-type': 'application/json' }, reqBody: JSON.stringify({ name: NAME }), json: { data: { contactName: NAME, iban: IBAN } } },
      { kind: 'ws', event: 'recv', url: 'wss://api.tr.com/', frame: `{"name":"${NAME}"}` },
    ],
    wsframes: [{ event: 'send', url: 'wss://api.tr.com/', frame: `sub {"token":"${JWT}"}` }],
    assets: [{ method: 'GET', url: `https://x.com/inv/${ORDERID}.pdf`, reqType: 'application/pdf' }],
  });
  assertClean(bundle, 'handoff');
  assert.equal(bundle.habeasHandoff, 1);
  assert.ok(!('auth' in bundle) && !('dom' in bundle), 'no auth / no page text');
  assert.equal(bundle.counts.samples, 2);
});
