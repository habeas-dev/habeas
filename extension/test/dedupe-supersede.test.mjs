// When a source changes HOW it identifies a movement, every movement it re-lists lands in the store a
// second time under the new identity. The store is additive by design — nothing prunes, which is what
// protects an archive from a bad read — so the old copies simply stay, and the user opens their archive to
// find everything doubled.
//
// The cleanup must never be "delete the old-looking ids". WiZink refuses statements older than 90 days
// (that request is what triggers its SMS), so a movement past that window is NEVER re-listed: its old-identity
// entry is the ONLY copy in existence. Deleting by shape would destroy it permanently.
//
// So the rule is about content, not about shape: within one source, entries that describe the SAME movement
// but were written by DIFFERENT source versions are the same thing recorded twice — keep what the newest
// version wrote, retire the rest. An entry with no newer twin is alone and is never touched.
//
// All values SYNTHETIC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supersededIds } from '../src/lib/migrate.js';

const rec = (o) => ({ date: '2026-07-27', amount: -12.4, currency: 'EUR', description: 'Panaderia La Espiga', group: 'Tarjeta 0000', ...o });
const items = (list) => Object.fromEntries(list.map(([id, srcVersion, r]) => [id, { record: rec(r), srcVersion }]));

test('the old copy is retired once the new one describes the same movement', () => {
  const gone = supersededIds(items([
    ['T0000|27 JUL|12,40 €|PANADERIA LA ESPIGA|0', '2026-08-26', {}],
    ['T0000|2026-07-27|-12.4|panaderia la espiga|0', '2026-08-28', {}],
  ]));
  assert.deepEqual(gone, ['T0000|27 JUL|12,40 €|PANADERIA LA ESPIGA|0'], 'only the superseded one');
});

test('a movement with NO newer twin is never touched — this is the 90-day archive', () => {
  // The case that must not go wrong. Nothing re-lists this movement, so its old entry is the only copy.
  const gone = supersededIds(items([
    ['T0000|02 FEB|55,00 €|GASOLINERA|0', '2026-08-26', { date: '2026-02-02', amount: -55, description: 'Gasolinera' }],
    ['T0000|2026-07-27|-12.4|panaderia la espiga|0', '2026-08-28', {}],
  ]));
  assert.deepEqual(gone, [], 'an unmatched old entry survives');
});

test('two genuinely distinct identical charges written by the SAME version both survive', () => {
  // Same signature, same source version → these are two real charges the source listed together, not one
  // charge recorded twice. Collapsing them would invent a refund.
  const gone = supersededIds(items([
    ['T0000|2026-07-27|-12.4|panaderia la espiga|0', '2026-08-28', {}],
    ['T0000|2026-07-27|-12.4|panaderia la espiga|1', '2026-08-28', {}],
  ]));
  assert.deepEqual(gone, [], 'same version means genuinely distinct movements');
});

test('two real charges re-listed: both old copies go, both new ones stay', () => {
  const gone = supersededIds(items([
    ['T0000|27 JUL|12,40 €|PANADERIA LA ESPIGA|0', '2026-08-26', {}],
    ['T0000|27 JUL|12,40 €|PANADERIA LA ESPIGA|1', '2026-08-26', {}],
    ['T0000|2026-07-27|-12.4|panaderia la espiga|0', '2026-08-28', {}],
    ['T0000|2026-07-27|-12.4|panaderia la espiga|1', '2026-08-28', {}],
  ]));
  assert.equal(gone.length, 2, 'both old copies retired');
  assert.ok(gone.every((id) => id.includes('JUL')), 'and it is the OLD pair that goes');
});

test('movements that differ in anything meaningful are never merged', () => {
  const gone = supersededIds(items([
    ['a', '2026-08-26', { amount: -12.4 }],
    ['b', '2026-08-28', { amount: -12.5 }],       // different amount
    ['c', '2026-08-28', { date: '2026-07-28' }],  // different day
    ['d', '2026-08-28', { group: 'Tarjeta 9999' }], // different account
    ['e', '2026-08-28', { description: 'Otro' }], // different concept
  ]));
  assert.deepEqual(gone, [], 'a signature is account + day + amount + currency + concept');
});

test('an entry already retired is not retired again, and never resurrects one', () => {
  const it = items([
    ['old', '2026-08-26', {}],
    ['new', '2026-08-28', {}],
  ]);
  it.old.gone = true;
  assert.deepEqual(supersededIds(it), [], 'idempotent: nothing left to do');
});

test('a missing source version counts as the oldest, not as the newest', () => {
  // Entries written before versions were stamped must not win over what the current source wrote.
  const gone = supersededIds(items([['legacy', undefined, {}], ['fresh', '2026-08-28', {}]]));
  assert.deepEqual(gone, ['legacy']);
});

test('nothing is retired when every entry comes from one version — the ordinary case', () => {
  assert.deepEqual(supersededIds(items([['x', '2026-08-28', {}], ['y', '2026-08-28', { amount: -1 }]])), []);
});

// ---------------------------------------------------------------- when the version signal is gone
//
// The migration's first phase re-normalizes records and stamps each one it touches with the CURRENT source
// version — and it runs immediately before the retirement, which distinguishes copies BY that version. So
// phase one erased the signal phase two depends on, and the tidy-up correctly reported "nothing to do"
// while the archive was visibly doubled. A second, independent signal is needed: the identity itself.
//
// An id the current source could not have produced is a stale one. The conservative, source-agnostic form
// of that test: the new identity carries the record's date as a segment, the old one carries whatever the
// page happened to print. Where there is no such signal, nothing is touched.

test('copies are told apart by their identity when the version no longer separates them', () => {
  const gone = supersededIds(items([
    ['T0000|27 JUL|12,40 €|PANADERIA LA ESPIGA|0', '2026-08-28', {}], // clobbered to the current version
    ['T0000|2026-07-27|-12.4|panaderia la espiga|0', '2026-08-28', {}],
  ]));
  assert.deepEqual(gone, ['T0000|27 JUL|12,40 €|PANADERIA LA ESPIGA|0'],
    'the identity the source can no longer produce is the stale one');
});

test('two copies BOTH carrying the current identity are still left alone', () => {
  // Two real charges, same day, same amount, same wording — indistinguishable, and both current. Collapsing
  // them would invent a refund.
  const gone = supersededIds(items([
    ['T0000|2026-07-27|-12.4|panaderia la espiga|0', '2026-08-28', {}],
    ['T0000|2026-07-27|-12.4|panaderia la espiga|1', '2026-08-28', {}],
  ]));
  assert.deepEqual(gone, []);
});

test('with no date to recognise, the identity signal is not used at all', () => {
  // A source whose record has no ISO date offers nothing to compare, so the rule stays silent rather than
  // guessing. Silence is the safe direction here.
  const gone = supersededIds(items([
    ['whatever-a', '2026-08-28', { date: '' }],
    ['whatever-b', '2026-08-28', { date: '' }],
  ]));
  assert.deepEqual(gone, []);
});

test('a lone stale-looking entry is STILL never touched', () => {
  // The 90-day guarantee does not depend on which signal fired. Alone in its signature means untouchable.
  const gone = supersededIds(items([['T0000|02 FEB|55,00 €|GASOLINERA|0', '2026-08-28', { date: '2026-02-02', amount: -55, description: 'Gasolinera' }]]));
  assert.deepEqual(gone, []);
});

test('the original version survives being written to the store', async () => {
  // cleanEntry keeps a fixed set of fields, so a new one is dropped on save unless it is listed. A signal
  // that does not survive a round trip is no signal.
  const { cleanEntry } = await import('../src/lib/store/format.js');
  const out = cleanEntry({ internalId: 'x', record: {}, srcVersion: '2026-08-28', srcVersionOrig: '2026-08-26' });
  assert.equal(out.srcVersionOrig, '2026-08-26');
});
