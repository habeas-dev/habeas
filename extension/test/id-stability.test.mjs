// `list.idOverride` exists to give a movement a STABLE natural key when the source's own id churns. Two
// independent defects made the key churn anyway, so the consumer — which dedupes by internalId, because
// that is what the data contract promises — filed the same movement again on every sync.
//
// All values SYNTHETIC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listInventory } from '../src/runtime/inventory.js';

const AUTH = { byPath: {}, merged: {} };
const netOf = (items) => async () => ({ ok: true, status: 200, json: async () => ({ movements: items }), text: async () => JSON.stringify({ movements: items }) });

// A card source: no per-row id in the page, so the key is the natural one. `ordinal: 'none'` is the
// statement reading — two charges that agree on account, day, amount and text are one line.
const CARD = (over = {}) => ({
  id: 'card', service: 'card', schema: 'transaction@1', currency: 'EUR',
  api: { host: 'https://x.test', list: { path: '/mov', itemsPath: 'movements', paging: 'none',
    idOverride: { when: { field: 'amount', present: true }, template: '{date}|{amount}|{description}', ...over } } },
  fields: { internalId: 'rowid', date: 'date', amount: 'amount', description: 'description' },
});
// `rowid` is deliberately NOT part of the key: it is how the TEST follows one movement across passes,
// standing in for the volatile identifier the site itself churns.
const row = (rowid, over = {}) => ({ rowid, date: '14 MAR', amount: '-12,40 €', description: 'Panaderia La Espiga', ...over });

test('(i) the same movement re-scraped with different letter case keeps its id', async () => {
  // The site renders the month upper-case while a charge is pending and lower-case once settled: a change
  // of STYLE, not of movement. The template was resolved against the RAW row, before normalization, so
  // "14 MAR" and "14 mar" minted two identities for one charge.
  const shouty = await listInventory(CARD({ ordinal: 'none' }), AUTH, netOf([row('a', { date: '14 MAR' })]));
  const quiet = await listInventory(CARD({ ordinal: 'none' }), AUTH, netOf([row('a', { date: '14 mar' })]));
  assert.equal(quiet[0].internalId, shouty[0].internalId, 'case alone must not mint a new identity');
});

test('(i-bis) the key is built from NORMALIZED values — ISO date, numeric amount', async () => {
  const [doc] = await listInventory(CARD({ ordinal: 'none' }), AUTH, netOf([row('a')]));
  assert.ok(!/MAR|mar/.test(doc.internalId), `no raw date string in the key: ${doc.internalId}`);
  assert.ok(!/€/.test(doc.internalId), `no raw amount in the key: ${doc.internalId}`);
  assert.match(doc.internalId, /\d{4}-\d{2}-\d{2}/, 'the date belongs in the key in ISO form');
});

test('(i-ter) spacing and case in the free text do not change the key either', async () => {
  const a = await listInventory(CARD({ ordinal: 'none' }), AUTH, netOf([row('a', { description: 'Panaderia La Espiga' })]));
  const b = await listInventory(CARD({ ordinal: 'none' }), AUTH, netOf([row('a', { description: '  PANADERIA   LA  ESPIGA ' })]));
  assert.equal(b[0].internalId, a[0].internalId, 'collapsed spacing + case must land on the same key');
});

test('(ii) a twin appearing ahead of it must not renumber the movement that was already delivered', async () => {
  // The reported failure exactly: movement B is alone in one sync and gets ordinal 0. In the next sync a
  // second charge A, identical in every keyed field, is listed BEFORE it — A takes 0, B becomes 1, and B,
  // already delivered, arrives at the consumer as new.
  const A = CARD({ ordinal: 'none' });
  const first = await listInventory(A, AUTH, netOf([row('B')]));
  const delivered = first[0].internalId; // what the consumer has already filed
  const second = await listInventory(A, AUTH, netOf([row('A'), row('B')]));
  const third = await listInventory(A, AUTH, netOf([row('B')])); // …and the twin settles away again
  assert.ok(second.map((d) => d.internalId).includes(delivered),
    'the identity already delivered must still be the one listed when a twin appears ahead of it');
  assert.deepEqual([...new Set(second.map((d) => d.internalId))], [delivered],
    'and no NEW identity may be minted for the same line — that is the duplicate the consumer sees');
  assert.equal(third[0].internalId, delivered, 'nor when the twin goes away again');
});

test("(ii-bis) the price of that: identical same-day charges become one line, as on a statement", async () => {
  // Stated as a test so the trade-off is explicit rather than discovered. Two charges indistinguishable in
  // account, day, amount and description cannot be told apart by anything the source gives us; the choice
  // is to merge them or to let every id churn whenever one of them appears. A statement merges.
  const docs = await listInventory(CARD({ ordinal: 'none' }), AUTH, netOf([row('A'), row('B')]));
  assert.equal(new Set(docs.map((d) => d.internalId)).size, 1, 'one identity for the pair');
});

// The ING contract that must NOT regress: its pending card charges churn their uuid, and two genuinely
// distinct same-day charges arrive together in one import and must stay apart. It keeps the default.
const ING = {
  id: 'ing', service: 'ing', schema: 'transaction@1', currency: 'EUR',
  api: { host: 'https://y.test', list: { path: '/mov', itemsPath: 'movements', paging: 'none',
    idOverride: { when: { field: 'status', present: true }, template: 'card|{date}|{amount}|{productId}' } } },
  fields: { internalId: 'uuid', date: 'date', amount: 'amount', description: 'merchant' },
};
const pending = (u) => ({ uuid: u, date: '2026-03-14', amount: -50, productId: 'GPAY', merchant: 'GOOGLE PAY', status: { description: 'Pendiente' } });

test('ING (default ordinal) still tells two distinct same-day charges apart', async () => {
  const docs = await listInventory(ING, AUTH, netOf([pending('u1'), pending('u2')]));
  assert.equal(docs.length, 2, 'two charges, two records');
  assert.equal(new Set(docs.map((d) => d.internalId)).size, 2, 'with distinct ids');
});

test('ING re-import with churned uuids still dedupes', async () => {
  const known = (await listInventory(ING, AUTH, netOf([pending('u1'), pending('u2')]))).map((d) => d.internalId);
  const again = await listInventory(ING, AUTH, netOf([pending('u3'), pending('u4')]), { knownIds: known });
  assert.equal(again.length, 0, 'nothing new on a re-import of the same two charges');
});
