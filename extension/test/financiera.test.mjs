import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory } from '../src/runtime/inventory.js';
import { validateAdapter } from '../src/adapters/validate.js';
import { resolveOutput, outputsOf } from '../src/lib/outputs.js';

const here = dirname(fileURLToPath(import.meta.url));
const ADP = JSON.parse(readFileSync(join(here, '../../sources-repo/sources/financiera-elcorteingles-es.json'), 'utf8'));

const okJson = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
const miss = { ok: false, status: 404, json: async () => ({}), text: async () => '' };
// All fictional — mirrors the shape (grouped by card): /dashboard/user → cards; per-card movements list.
const CARD = { contract_number: 'C0001', encryptedPan: 'ENCPAN0001', cardLabel: 'ECI Visa', masked_pan: '**** 0000' };

test('Financiera ECI adapter validates (all streams)', () => {
  const v = validateAdapter(ADP);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepEqual(outputsOf(ADP).map((o) => o.id), ['movimientos', 'aplazamientos', 'extractos']);
});

test('movimientos: per-group accountNumber + eci-custom-encrypted-pan header, mapped to transactions', async () => {
  let movUrl = '', movInit = null;
  const net = async (url, init) => {
    if (url.endsWith('/dashboard/user')) return okJson({ userEciCardList: [CARD] });
    if (url.includes('movements-close')) {
      movUrl = url; movInit = init;
      return okJson({ movements: [
        { invoiceNumber: 'INV1', operationDate: '2020-05-05', amount: '9,99€', company: 'DEMO STORE', center: 'MADRID', centerCode: '0012', type: '0006' },
        { invoiceNumber: 'INV2', operationDate: '2020-06-07', amount: '4,00€', company: 'OTHER', center: 'BCN', centerCode: '0034', type: '0019' },
      ] });
    }
    return miss;
  };
  const EFF = resolveOutput(ADP, 'movimientos');
  const docs = await listInventory(EFF, { merged: {}, byPath: {}, ctx: {} }, net, {});

  assert.ok(movUrl.includes('accountNumber=C0001'), 'accountNumber templated from {group.id}');
  assert.ok(movUrl.includes('operationType=A'), 'enum params sent');
  assert.equal(movInit.headers['eci-custom-encrypted-pan'], 'ENCPAN0001', 'per-group header templated from {group.pan}'); // the new runtime feature
  assert.equal(docs.length, 2);
  const byId = Object.fromEntries(docs.map((d) => [d.internalId, d.record]));
  assert.equal(byId.INV1.date, '2020-05-05');
  assert.equal(byId.INV1.amount, 9.99);
  assert.equal(byId.INV1.currency, 'EUR');
  assert.ok(byId.INV1.extra, 'keepRaw kept the full movement');
});
