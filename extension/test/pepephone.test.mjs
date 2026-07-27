import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expandItems, listInventory } from '../src/runtime/inventory.js';
import { validateAdapter } from '../src/adapters/validate.js';

test('expandItems: one item per sub-invoice, inheriting the parent (sub wins), sub-array dropped', () => {
  const items = [
    { number: 'A', date: 1769000000, serviceType: 'PPH', total: 30, subInvoices: [{ number: 'A', total: 20, typeDescription: 'Línea' }, { number: 'B', total: 10, typeDescription: 'Dispositivo' }] },
    { number: 'C', date: 1766000000, serviceType: 'PPH', total: 15, subInvoices: [] }, // no subs → kept as-is
  ];
  const out = expandItems(items, { path: 'subInvoices' });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((x) => x.number), ['A', 'B', 'C']);
  assert.equal(out[0].date, 1769000000); assert.equal(out[0].total, 20); assert.equal(out[0].typeDescription, 'Línea'); // parent date, sub total
  assert.equal(out[1].date, 1769000000); assert.equal(out[1].total, 10); assert.equal(out[1].serviceType, 'PPH');
  assert.ok(!('subInvoices' in out[0]), 'the sub-array is dropped from each expanded item');
  assert.equal(out[2].total, 15); // sub-less invoice unchanged
  assert.deepEqual(expandItems(items, null).length, 2, 'no expand config → untouched');
});

// End-to-end on a SYNTHETIC Pepephone-shaped response (all values invented): a PPH month with two sub-invoices
// and a PPE (energy) month that must be filtered out. Confirms expand + keep(PPH) + epoch window + PDF templating.
const here = dirname(fileURLToPath(import.meta.url));
const ADAPTER = JSON.parse(readFileSync(join(here, '../../sources-repo/sources/pepephone-es.json'), 'utf8'));
const RESP = { invoices: [
  { number: '2026-06-PPH', date: 1780000000, total: 42.9, serviceType: 'PPH', typeDescription: '', subInvoices: [
    { number: '2026-06-PPH', total: 32.9, type: 'L', typeDescription: 'Línea móvil' },
    { number: '2026-06-DEV', total: 10, type: 'D', typeDescription: 'Cuota dispositivo' } ] },
  { number: '2026-06-PPE', date: 1780000000, total: 60, serviceType: 'PPE', typeDescription: 'Energía', subInvoices: [] }, // energy → excluded
], remaining: { countPPE: 1, countPPH: 1 } };

test('Pepephone adapter validates', () => { const v = validateAdapter(ADAPTER); assert.ok(v.ok, JSON.stringify(v)); });

test('lists one doc per PPH sub-invoice; excludes the PPE (energy) invoice', async () => {
  const net = async () => ({ ok: true, status: 200, json: async () => RESP, text: async () => JSON.stringify(RESP) });
  const auth = { merged: { authorization: 'Bearer eyJx' }, byPath: {}, ctx: {} };
  const docs = await listInventory(ADAPTER, auth, net, {});
  assert.deepEqual(docs.map((d) => d.internalId).sort(), ['2026-06-DEV', '2026-06-PPH'], 'both PPH sub-invoices, no PPE');
  const dev = docs.find((d) => d.internalId === '2026-06-DEV');
  assert.equal(dev.total, 10); assert.equal(dev.record.total, 10);
});

test('expandItems drop: a sub without its own total does NOT inherit the parent total (stays empty)', () => {
  const items = [{ number: 'M', date: 1, total: 42.9, subInvoices: [
    { number: 'M', typeDescription: 'Línea' },          // no own total → must NOT become 42.9
    { number: 'D', total: 10, typeDescription: 'Disp.' }, // own total wins
  ] }];
  const out = expandItems(items, { path: 'subInvoices', drop: ['total'] });
  assert.equal(out[0].total, undefined, 'sub without total is empty, not the month total');
  assert.equal(out[1].total, 10);
  // without drop it WOULD wrongly inherit the parent total (the bug being fixed)
  assert.equal(expandItems(items, { path: 'subInvoices' })[0].total, 42.9);
});
