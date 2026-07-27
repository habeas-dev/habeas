import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instrumentLabel, displayName, displayAmount, SIDE_DIR, sideKey, isInvestmentRec } from '../src/lib/recdisplay.js';

test('instrumentLabel: object name > ticker > isin; bare string; empty otherwise', () => {
  assert.equal(instrumentLabel({ instrument: { name: 'Apple Inc', ticker: 'AAPL', isin: 'US0378331005' } }), 'Apple Inc');
  assert.equal(instrumentLabel({ instrument: { ticker: 'AAPL' } }), 'AAPL');
  assert.equal(instrumentLabel({ instrument: { isin: 'US0378331005' } }), 'US0378331005');
  assert.equal(instrumentLabel({ instrument: 'Vanguard S&P 500' }), 'Vanguard S&P 500'); // investment@1 string
  assert.equal(instrumentLabel({ counterparty: 'Bank' }), '');
});

test('displayName: a trade shows its instrument, not the store/category', () => {
  const trade = { recordType: 'trade', instrument: { name: 'Tesla' }, side: 'buy', netAmount: 900, category: 'banking' };
  assert.equal(displayName(trade), 'Tesla');
  // cash movement → falls through to description; a receipt → store name
  assert.equal(displayName({ recordType: 'cash', kind: 'interest', description: 'Interés cuenta', amount: 3.2 }), 'Interés cuenta');
  assert.equal(displayName({ store: { name: 'Carrefour' } }), 'Carrefour');
  assert.equal(displayName({ counterparty: 'ACME' }), 'ACME');
  assert.equal(displayName({}), '');
});

test('displayAmount: total/amount, else an investment settlement (netAmount then grossAmount)', () => {
  assert.equal(displayAmount({ total: 12.5 }), 12.5);
  assert.equal(displayAmount({ amount: -20 }), -20);
  assert.equal(displayAmount({ recordType: 'trade', netAmount: 900, grossAmount: 890 }), 900); // net wins
  assert.equal(displayAmount({ recordType: 'trade', grossAmount: 890 }), 890);
  assert.equal(displayAmount({ recordType: 'trade' }), null);
});

test('sideKey + SIDE_DIR: normalize the operation and map it to a money direction', () => {
  assert.equal(sideKey({ side: 'Transfer-In' }), 'transfer_in');
  assert.equal(sideKey({ kind: 'interest' }), 'interest');
  assert.equal(SIDE_DIR[sideKey({ side: 'buy' })], 'out');   // invested
  assert.equal(SIDE_DIR[sideKey({ side: 'sell' })], 'in');   // divested
  assert.equal(SIDE_DIR[sideKey({ side: 'dividend' })], 'in');
  assert.equal(SIDE_DIR[sideKey({ side: 'split' })], undefined); // moves no money
});

test('isInvestmentRec: only trade/cash records', () => {
  assert.equal(isInvestmentRec({ recordType: 'trade' }), true);
  assert.equal(isInvestmentRec({ recordType: 'cash' }), true);
  assert.equal(isInvestmentRec({ type: 'HYPERMARKET' }), false);
  assert.equal(isInvestmentRec(null), false);
});
