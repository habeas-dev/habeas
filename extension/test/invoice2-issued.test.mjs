// invoice@2 — an ISSUED invoice: a self-billing ("reverse") invoice a platform (Freemius, Paddle) issues IN THE
// USER'S NAME to itself for each payout. Agreed with Cuéntamo: `flow` 'issued' declared by the source; the
// platform as `recipient` {name, taxId, country, address}, symmetric to `issuer`; `issuer` is the user and only
// present when the dashboard states it. Empty sub-fields are omitted, never "".
//
// Every value below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord } from '../src/sinks/format.js';

const ADP = { id: 'demo-payouts', schema: 'invoice@2', fields: {} };
const base = {
  internalId: 'ri_EXAMPLE0001', number: 'RI-2026-0042', date: '2026-10-03', flow: 'issued',
  periodStart: '2026-09-01', periodEnd: '2026-09-30',
  recipientName: 'Demo Platform Inc.', recipientTaxId: 'EU000000000', recipientCountry: 'US', recipientAddress: '',
  total: '123.45', currency: 'USD',
  accountId: 'prod_0001', accountLabel: 'Demo plugin',
  source: 'demo-payouts', type: 'reverse_invoice',
};

test('invoice@2 issued: flow, the platform as recipient, no issuer when the dashboard gives none', () => {
  const r = buildRecord(base, ADP);
  assert.equal(r._schema, 'invoice@2');
  assert.equal(r.flow, 'issued');
  assert.deepEqual(r.recipient, { name: 'Demo Platform Inc.', taxId: 'EU000000000', country: 'US' });
  assert.ok(!('issuer' in r), 'issuer absent');
  assert.ok(!('recipientTaxId' in r), 'the tax id lives in recipient, not duplicated at the top');
  assert.equal(r.number, 'RI-2026-0042');
  assert.equal(r.issueDate, '2026-10-03');
  assert.equal(r.total, 123.45);
  assert.equal(r.currency, 'USD');
  assert.deepEqual(r.servicePeriod, { start: '2026-09-01', end: '2026-09-30' });
  assert.deepEqual(r.account, { id: 'prod_0001', label: 'Demo plugin' });
  assert.equal(r.type, 'reverse_invoice');
});

test('invoice@2 issued: the user as issuer when the dashboard states it', () => {
  const r = buildRecord({ ...base, issuerName: 'Demo Developer', issuerTaxId: 'ESX0000000X', issuerCountry: 'ES' }, ADP);
  assert.deepEqual(r.issuer, { name: 'Demo Developer', taxId: 'ESX0000000X', country: 'ES' });
});

test('invoice@2 issued: no recipient data → no recipient key; recipient fields never leak into extra', () => {
  const r = buildRecord({ ...base, recipientName: '', recipientTaxId: undefined, recipientCountry: null }, { ...ADP, fields: { recipientName: 'x' } });
  assert.ok(!('recipient' in r));
  assert.ok(!r.extra || !Object.keys(r.extra).some((k) => k.startsWith('recipient') || k === 'flow'));
});

test('invoice@2: flow defaults to received; an unknown flow value is not trusted', () => {
  assert.equal(buildRecord({ ...base, flow: undefined }, ADP).flow, 'received');
  assert.equal(buildRecord({ ...base, flow: 'sideways' }, ADP).flow, 'received');
});

test('invoice@2 received is unchanged: recipientTaxId stays at the top, no recipient object', () => {
  const r = buildRecord({ ...base, flow: 'received', recipientName: undefined, recipientCountry: undefined }, ADP);
  assert.equal(r.recipientTaxId, 'EU000000000');
  assert.ok(!('recipient' in r));
});
