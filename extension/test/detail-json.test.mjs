import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDetailFields, normalizeAmount } from '../src/runtime/inventory.js';

test('normalizeAmount parses both EUR and US/UK number formats + currency symbols', () => {
  assert.equal(normalizeAmount('US$9.99'), 9.99);
  assert.equal(normalizeAmount('US$1,234.56'), 1234.56); // US thousands + dot decimal
  assert.equal(normalizeAmount('9,99 €'), 9.99);
  assert.equal(normalizeAmount('1.234,56 €'), 1234.56);  // EUR thousands + comma decimal
  assert.equal(normalizeAmount('1.234 €'), 1234);        // EUR thousands, no cents
  assert.equal(normalizeAmount('£12.50'), 12.5);
  assert.equal(normalizeAmount('¥1500'), 1500);
  assert.equal(normalizeAmount('-5,00'), -5);
});

// Synthetic PayPal-shaped detail (NO real values) — the SHAPE mirrors /myaccount/activities/details/inline/{id}.
const DETAIL = JSON.stringify({
  data: {
    displayStatus: 'COMPLETED',
    invoiceId: 'INV-TEST-1',
    isCredit: false,
    amount: {
      rawAmounts: { gross: { value: 12.5, currencyCode: 'EUR' } },
      netAmount: '11,80 €',
      feeAmount: '0,70 €',
    },
    counterparty: { name: 'Test Shop', email: 'shop@example.test', isBusiness: true },
    itemDetails: {
      itemList: [
        { name: 'Widget', price: '10,00 €', itemTotalPrice: '10,00 €' },
        { name: 'Gadget', price: '2,50 €', itemTotalPrice: '2,50 €' },
      ],
    },
  },
});

const CFG = {
  json: true,
  root: 'data',
  fields: {
    status: 'displayStatus',
    invoiceId: 'invoiceId',
    gross: 'amount.rawAmounts.gross.value',
    currency: 'amount.rawAmounts.gross.currencyCode',
    net: 'amount.netAmount',
    fee: 'amount.feeAmount',
    counterparty: 'counterparty.name',
    counterpartyEmail: 'counterparty.email',
    isBusiness: 'counterparty.isBusiness',
  },
  items: { path: 'itemDetails.itemList', fields: { name: 'name', price: 'price', total: 'itemTotalPrice' } },
};

test('extractDetailFields maps a JSON detail via dotted paths, under a root', () => {
  const rec = extractDetailFields(DETAIL, CFG);
  assert.equal(rec.status, 'COMPLETED');
  assert.equal(rec.invoiceId, 'INV-TEST-1');
  assert.equal(rec.currency, 'EUR');
  assert.equal(rec.counterparty, 'Test Shop');
  assert.equal(rec.counterpartyEmail, 'shop@example.test');
  assert.equal(rec.isBusiness, true);
});

test('numeric detail amounts pass through; locale-formatted ones are normalized', () => {
  const rec = extractDetailFields(DETAIL, CFG);
  assert.equal(rec.gross, 12.5);      // already numeric → unchanged
  assert.equal(rec.net, 11.8);        // "11,80 €" → 11.8
  assert.equal(rec.fee, 0.7);         // "0,70 €"  → 0.7
});

test('line items are extracted with per-element paths and normalized prices', () => {
  const rec = extractDetailFields(DETAIL, CFG);
  assert.equal(rec.items.length, 2);
  assert.equal(rec.items[0].name, 'Widget');
  assert.equal(rec.items[0].price, 10);
  assert.equal(rec.items[1].total, 2.5);
});
