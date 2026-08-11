import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferCurrency, inferTokenFromStorage } from '../src/runtime/inferextras.js';

// Two more fields the recording already answers. All values synthetic.

// ---------------------------------------------------------------- currency

test('an explicit currency field in the items is the answer', () => {
  const items = [
    { id: 'A', importe: 12.5, divisa: 'EUR' },
    { id: 'B', importe: 3.2, divisa: 'EUR' },
  ];
  assert.equal(inferCurrency(items), 'EUR');
});

test('a symbol attached to the amount is enough when there is no currency field', () => {
  assert.equal(inferCurrency([{ id: 'A', total: '$14.99' }, { id: 'B', total: '$2.00' }]), 'USD');
  assert.equal(inferCurrency([{ id: 'A', total: '19,90 €' }]), 'EUR');
  assert.equal(inferCurrency([{ id: 'A', total: '£7.25' }]), 'GBP');
});

test('the majority wins — one foreign-currency purchase does not redefine the source', () => {
  const items = [
    { id: 'A', currency: 'EUR' }, { id: 'B', currency: 'EUR' },
    { id: 'C', currency: 'EUR' }, { id: 'D', currency: 'USD' },
  ];
  assert.equal(inferCurrency(items), 'EUR');
});

test('nothing is emitted when the items never say, or say too many different things', () => {
  assert.equal(inferCurrency([{ id: 'A', total: 12.5 }, { id: 'B', total: 3 }]), '');
  assert.equal(inferCurrency([]), '');
  assert.equal(inferCurrency(null), '');
  // A genuinely multi-currency list has no single source currency to declare.
  assert.equal(inferCurrency([{ currency: 'USD' }, { currency: 'EUR' }, { currency: 'GBP' }]), '');
});

test('a bare three-letter word that is not a currency is not mistaken for one', () => {
  assert.equal(inferCurrency([{ id: 'A', tipo: 'ABC', total: 5 }]), '');
});

// ---------------------------------------------------------------- tokenFromStorage

const bearer = (v) => ({ url: 'https://api.demo.test/x', reqHeaders: { authorization: 'Bearer ' + v } });
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl';

test('the sent bearer is located in localStorage, key and field', () => {
  const storage = { local: { auth_token: JSON.stringify({ access_token: JWT, refresh_token: 'rrr' }) }, session: {} };
  assert.deepEqual(inferTokenFromStorage([bearer(JWT)], storage), {
    key: 'auth_token', field: 'access_token', scheme: 'Bearer', header: 'authorization',
  });
});

test('a token stored bare under its key needs no field', () => {
  const storage = { local: { DEMO_AUTH_TOKEN: JWT }, session: {} };
  assert.deepEqual(inferTokenFromStorage([bearer(JWT)], storage), {
    key: 'DEMO_AUTH_TOKEN', field: '', scheme: 'Bearer', header: 'authorization',
  });
});

test('a nested token yields its dotted path', () => {
  const storage = { local: { session: JSON.stringify({ user: { creds: { token: JWT } } }) }, session: {} };
  const got = inferTokenFromStorage([bearer(JWT)], storage);
  assert.equal(got.key, 'session');
  assert.equal(got.field, 'user.creds.token');
});

test('a bearer that is not in storage yields nothing — there is nothing to read fresh', () => {
  assert.equal(inferTokenFromStorage([bearer(JWT)], { local: { other: 'x' }, session: {} }), null);
  assert.equal(inferTokenFromStorage([bearer(JWT)], null), null);
  assert.equal(inferTokenFromStorage([], { local: { k: JWT } }), null);
});

test('a redacted bearer yields nothing rather than a wrong location', () => {
  assert.equal(inferTokenFromStorage([bearer('[cred]')], { local: { k: JWT } }), null);
});

test('the header actually used is carried, not assumed', () => {
  const storage = { local: { tok: JWT } };
  const s = { url: 'https://api.demo.test/x', reqHeaders: { 'x-auth-token': JWT } };
  const got = inferTokenFromStorage([s], storage);
  assert.equal(got.header, 'x-auth-token');
  assert.equal(got.scheme, '', 'no scheme prefix was used, so none should be added back');
});

// ---------------------------------------------------------------- wiring into the drafter

test('a drafted source declares the currency and where to read the token', async () => {
  const { draftAdapterFromSamples } = await import('../src/runtime/infer.js');
  const items = Array.from({ length: 5 }, (_, i) => ({
    id: 'P' + i, fecha: '2026-03-0' + (i + 1), total: `${i + 1}.99`, divisa: 'USD', comercio: 'Tienda ' + i,
  }));
  const samples = [{
    url: 'https://api.demo.test/v1/orders?limit=50', method: 'GET', status: 200,
    reqHeaders: { authorization: 'Bearer ' + JWT },
    json: { orders: items },
  }];
  const storage = { local: { auth_token: JSON.stringify({ access_token: JWT }) }, session: {} };
  const r = draftAdapterFromSamples(samples, { storage });
  assert.ok(r.ok, `draft failed: ${r.reason || ''}`);
  assert.equal(r.draft.currency, 'USD', 'the currency should reach the draft');
  assert.deepEqual(r.draft.auth.tokenFromStorage, { key: 'auth_token', field: 'access_token', scheme: 'Bearer', header: 'authorization' });
});
