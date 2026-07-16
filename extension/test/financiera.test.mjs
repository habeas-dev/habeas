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
const CARD = { contract_number: 'C0001', encryptedPan: 'AbC+dEf/gHi012=', cardLabel: 'ECI Visa', masked_pan: '**** 0000' }; // base64 pan (with +/=)

test('Financiera ECI adapter validates (all streams)', () => {
  const v = validateAdapter(ADP);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepEqual(outputsOf(ADP).map((o) => o.id), ['movimientos', 'aplazamientos', 'extractos']);
});

const mov = (id, date, amount) => ({ invoiceNumber: id, operationDate: date, amount, company: 'DEMO STORE', center: 'MADRID', centerCode: '0012', type: '0006' });

test('movimientos: unions the monthFilter views (paramSets), per-group header verbatim, mapped to transactions', async () => {
  const calls = []; let lastHdr = null, lastUrl = '';
  const net = async (url, init) => {
    if (url.endsWith('/dashboard/user')) return okJson({ userEciCardList: [CARD] });
    if (url.includes('movements-close')) {
      calls.push(url); lastUrl = url; lastHdr = init.headers['eci-custom-encrypted-pan'];
      if (url.includes('monthFilter=N')) return okJson({ movements: [mov('INV1', '2020-05-05', '9,99€'), mov('INV2', '2020-06-07', '4,00€'), mov('INV3', '2020-06-08', '1,00€')] });
      if (url.includes('monthFilter=A')) return okJson({ movements: [mov('INV4', '2020-07-01', '2,00€'), mov('INV5', '2020-07-02', '3,00€')] });
      return okJson({ movements: [] });
    }
    return miss;
  };
  const EFF = resolveOutput(ADP, 'movimientos');
  const docs = await listInventory(EFF, { merged: {}, byPath: {}, ctx: {} }, net, {});

  // the SPA loads all movements as disjoint monthFilter views → the adapter replays each set and unions
  assert.equal(calls.length, 2, 'one list call per paramSet (N + A)');
  assert.ok(calls.some((u) => u.includes('monthFilter=N')) && calls.some((u) => u.includes('monthFilter=A')));
  assert.ok(lastUrl.includes('accountNumber=C0001') && lastUrl.includes('operationType=A'));
  assert.equal(lastHdr, 'AbC+dEf/gHi012=', 'per-group header sent VERBATIM (base64 not URL-encoded)');
  assert.equal(docs.length, 5, 'union of both views (3 + 2)');
  const byId = Object.fromEntries(docs.map((d) => [d.internalId, d.record]));
  assert.equal(byId.INV1.date, '2020-05-05');
  assert.equal(byId.INV1.amount, 9.99);
  assert.equal(byId.INV1.currency, 'EUR');
  assert.ok(byId.INV1.extra, 'keepRaw kept the full movement');
});
