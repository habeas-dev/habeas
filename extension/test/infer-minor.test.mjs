import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferMinorUnits } from '../src/runtime/inferextras.js';

// Amounts in minor units (cents). Getting this wrong multiplies every amount by 100 in silence, so it is
// only claimed on positive evidence: the value the page SHOWED the user disagrees with the raw one by
// exactly a factor of 100. All data synthetic.

const items = (vals) => vals.map((v, i) => ({ id: 'T' + i, amount: v }));

test('raw integers that the page renders 100x smaller are minor units', () => {
  const page = 'Movimientos 12,50 € 3,99 € 145,00 € Total';
  assert.equal(inferMinorUnits(items([1250, 399, 14500]), 'amount', page), true);
});

test('a dot decimal separator works as well as a comma', () => {
  assert.equal(inferMinorUnits(items([1250, 399, 14500]), 'amount', '$12.50 $3.99 $145.00'), true);
});

test('thousands separators in the rendering do not hide the match', () => {
  const page = 'Cargo 1.234,56 € · 2.000,00 € · 987,65 €';
  assert.equal(inferMinorUnits(items([123456, 200000, 98765]), 'amount', page), true);
});

test('amounts the page shows unchanged are NOT minor units', () => {
  const page = 'Movimientos 1250 € 399 € 14500 €';
  assert.equal(inferMinorUnits(items([1250, 399, 14500]), 'amount', page), false);
});

test('nothing is claimed without the rendered page to check against', () => {
  assert.equal(inferMinorUnits(items([1250, 399, 14500]), 'amount', ''), null);
  assert.equal(inferMinorUnits(items([1250, 399, 14500]), 'amount', null), null);
});

test('nothing is claimed when the amounts are not whole numbers', () => {
  // A value of 12.5 is already in major units; there is nothing to scale.
  assert.equal(inferMinorUnits(items([12.5, 3.99, 145]), 'amount', '12,50 € 3,99 € 145,00 €'), null);
});

test('nothing is claimed on too little evidence', () => {
  assert.equal(inferMinorUnits(items([1250]), 'amount', '12,50 €'), null);
  assert.equal(inferMinorUnits([], 'amount', '12,50 €'), null);
  assert.equal(inferMinorUnits(null, 'amount', 'x'), null);
});

test('a single coincidental match does not outvote the rest', () => {
  // Only one of three lines up as cents; the others appear as-is. Not enough to rescale everything.
  const page = '12,50 € 399 € 14500 €';
  assert.equal(inferMinorUnits(items([1250, 399, 14500]), 'amount', page), false);
});

test('the amount is reached through a dotted path', () => {
  const rows = [
    { id: 'A', money: { value: 1250 } }, { id: 'B', money: { value: 399 } }, { id: 'C', money: { value: 14500 } },
  ];
  assert.equal(inferMinorUnits(rows, 'money.value', '12,50 € 3,99 € 145,00 €'), true);
});

test('negative amounts are matched by magnitude, not sign', () => {
  assert.equal(inferMinorUnits(items([-1250, -399, -14500]), 'amount', '-12,50 € -3,99 € -145,00 €'), true);
});
