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

test('(ii) the ordinal is scoped to the KEY: a lone movement is |0 in every run', async () => {
  // The guarantee the consumer depends on. The ids of one natural key are always the dense prefix
  // |0…|n-1, so a movement delivered as |0 stays |0 for ever — no other movement that day, and no change
  // in what else the run contains, can renumber it.
  const A = CARD();
  const alone = await listInventory(A, AUTH, netOf([row('B')]));
  const amongOthers = await listInventory(A, AUTH, netOf([
    { rowid: 'Z', date: '14 MAR', amount: '-3,10 €', description: 'Cafe Central' },
    row('B'),
    { rowid: 'Y', date: '14 MAR', amount: '-9,00 €', description: 'Quiosco' },
  ]));
  assert.match(alone[0].internalId, /\|0$/, 'a lone movement is always subID 0');
  assert.ok(amongOthers.map((d) => d.internalId).includes(alone[0].internalId),
    'movements with OTHER keys the same day must not renumber it');
  assert.deepEqual(amongOthers.map((d) => d.internalId).filter((id) => !/\|0$/.test(id)), [],
    'each distinct key starts its own count at 0');
});

test('(ii-bis) identical movements take consecutive subIDs from 0, whatever the listing order', async () => {
  const A = CARD();
  const forwards = await listInventory(A, AUTH, netOf([row('A'), row('B')]));
  const backwards = await listInventory(A, AUTH, netOf([row('B'), row('A')]));
  const set = (docs) => [...new Set(docs.map((d) => d.internalId))].sort();
  assert.equal(set(forwards).length, 2, 'two identical movements, two subIDs');
  assert.deepEqual(set(backwards), set(forwards), 'the same pair of ids regardless of order listed');
  assert.deepEqual(set(forwards).map((id) => id.slice(-2)), ['|0', '|1'], 'and they are 0 and 1, never other numbers');
});

test('(ii-ter) growing from one identical movement to three only ADDS ids', async () => {
  // Why the prefix rule matters: what was already delivered is never re-minted, so a sync that finds more
  // of the same charge produces exactly the new ones and no duplicates.
  const A = CARD();
  const one = (await listInventory(A, AUTH, netOf([row('A')]))).map((d) => d.internalId);
  const three = (await listInventory(A, AUTH, netOf([row('A'), row('B'), row('C')]))).map((d) => d.internalId);
  assert.ok(one.every((id) => three.includes(id)), 'every id already delivered survives');
  assert.equal(three.length - one.length, 2, 'and exactly the genuinely new ones are added');
});

test("(ii-quater) 'none' is for a source that lists the SAME movement twice in one pass", async () => {
  // WiZink shows a charge under the current unbilled period and again inside the statement that bills it.
  // Those are one movement, so one identity — otherwise the consumer files it twice, which is the defect
  // actually observed. The price, stated so it is a decision and not a surprise: two genuinely distinct
  // identical same-day charges also become one line, as they are on a paper statement.
  const docs = await listInventory(CARD({ ordinal: 'none' }), AUTH, netOf([row('pending'), row('billed')]));
  assert.equal(new Set(docs.map((d) => d.internalId)).size, 1, 'one identity for the two sightings');
  assert.ok(!/\|\d+$/.test(docs[0].internalId), 'and no ordinal suffix at all');
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

// `when` gates the override to the items whose id is untrustworthy — ING's pending card charges. A source
// whose id is untrustworthy for EVERY row (Revolut re-mints it for completed transactions too) had nothing
// to discriminate on, and the only way to express "all of them" was a predicate that is always true. That
// is a lie in the definition, so `when` is optional: absent means every item.
const ALL = {
  id: 'rev', service: 'rev', schema: 'transaction@1', currency: 'EUR',
  api: { host: 'https://z.test', list: { path: '/m', itemsPath: 'movements', paging: 'none',
    idOverride: { template: '{startedDate}|{amount}|{currency}|{description}' } } },
  fields: { internalId: 'id', date: 'startedDate', amount: 'amount', currency: 'currency', description: 'description' },
};
const tx = (id) => ({ id, startedDate: '2026-03-14', amount: -12.4, currency: 'EUR', description: 'Panaderia La Espiga' });

test('idOverride without `when` applies to every item', async () => {
  const first = await listInventory(ALL, AUTH, netOf([tx('11111111-1111-4111-8111-111111111111')]));
  const second = await listInventory(ALL, AUTH, netOf([tx('22222222-2222-4222-8222-222222222222')]));
  assert.ok(!/1111|2222/.test(first[0].internalId), 'the volatile id must not survive into the key');
  assert.equal(second[0].internalId, first[0].internalId,
    'a re-minted identifier for the same transaction must not produce a second record');
});

test('and it still numbers genuine repeats 0,1 — the prefix rule holds here too', async () => {
  const docs = await listInventory(ALL, AUTH, netOf([tx('a'), tx('b')]));
  assert.deepEqual([...new Set(docs.map((d) => d.internalId))].sort().map((s) => s.slice(-2)), ['|0', '|1']);
});
