import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchMovement } from '../src/lib/match.js';

// "What was this 43,20 EUR charge?" — asked by a person of their own archive, and by a consumer that
// holds the bank movement and deliberately does NOT hold the invoices. Cuéntamo does not want Amazon's
// five thousand receipts; it wants the right one shown when the user asks. So the matching runs here and
// Habeas displays the answer, which is what lets the capability be broad without anything crossing.

const doc = (source, id, date, total, extra = {}) => ({ source, internalId: id, record: { date, total, currency: 'EUR', ...extra } });
const MOV = { amount: -43.20, date: '2026-03-04', currency: 'EUR' };

test('the amount is the entry ticket — a near miss is not a match', () => {
  const r = matchMovement(MOV, [doc('amazon:', 'A', '2026-03-04', 43.19)]);
  assert.equal(r.length, 0, 'a cent apart is a different purchase');
});

test('sign is irrelevant: a charge of -43,20 matches a receipt of 43,20', () => {
  const r = matchMovement(MOV, [doc('amazon:', 'A', '2026-03-04', 43.20)]);
  assert.equal(r.length, 1);
  assert.ok(r[0].why.includes('amount'));
});

test('a card charge settling days later still matches, and ranks below the same day', () => {
  const r = matchMovement(MOV, [
    doc('amazon:', 'LATE', '2026-03-01', 43.20),
    doc('carrefour-es:', 'SAME', '2026-03-04', 43.20),
  ]);
  assert.deepEqual(r.map((x) => x.internalId), ['SAME', 'LATE']);
  assert.ok(r[0].why.includes('same-day'));
  assert.ok(r[1].why.includes('3d'));
});

test('beyond the window it stops being a candidate', () => {
  const r = matchMovement(MOV, [doc('amazon:', 'OLD', '2026-02-20', 43.20)]);
  assert.equal(r.length, 0);
  assert.equal(matchMovement(MOV, [doc('amazon:', 'OLD', '2026-02-20', 43.20)], { windowDays: 20 }).length, 1);
});

test('a shared merchant name corroborates but is never required', () => {
  const withParty = { ...MOV, counterparty: 'AMAZON EU SARL' };
  const r = matchMovement(withParty, [
    doc('carrefour-es:', 'OTHER', '2026-03-04', 43.20, { store: { name: 'Carrefour' } }),
    doc('amazon:', 'AMZ', '2026-03-04', 43.20, { counterparty: 'Amazon' }),
  ]);
  assert.equal(r[0].internalId, 'AMZ', 'the merchant match must win a tie');
  assert.ok(r[0].why.includes('counterparty'));
  assert.equal(r.length, 2, 'and the other stays a candidate — banks often write no merchant at all');
});

test('currencies are never converted, so a rate is never invented', () => {
  // A EUR movement and a GBP receipt may well be the same purchase. Guessing the rate to say so would
  // manufacture a match, and a manufactured match in a ledger is worse than a missing one.
  const r = matchMovement(MOV, [doc('amazon:', 'GBP', '2026-03-04', 36.30, { currency: 'GBP' })]);
  assert.equal(r.length, 0);
});

test('a document with no amount cannot be matched on one', () => {
  const r = matchMovement(MOV, [{ source: 'ing-es:movimientos', internalId: 'X', record: { date: '2026-03-04' } }]);
  assert.equal(r.length, 0);
});

test('an unusable movement returns nothing rather than everything', () => {
  assert.deepEqual(matchMovement({ date: '2026-03-04' }, [doc('a:', 'A', '2026-03-04', 1)]), []);
  assert.deepEqual(matchMovement({ amount: -1 }, [doc('a:', 'A', '2026-03-04', 1)]), []);
  assert.deepEqual(matchMovement(null, [doc('a:', 'A', '2026-03-04', 1)]), []);
});

test('every candidate says WHY, in words', () => {
  // A score nobody can argue with is worse than no score: this sits next to somebody's money, and "why is
  // that the top match" must always have an answer.
  const r = matchMovement({ ...MOV, counterparty: 'Amazon' }, [doc('amazon:', 'A', '2026-03-04', 43.20, { counterparty: 'Amazon' })]);
  assert.deepEqual(r[0].why, ['amount', 'same-day', 'currency', 'counterparty']);
});
