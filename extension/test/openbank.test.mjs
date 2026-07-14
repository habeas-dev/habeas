import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory, fetchArtifact, artifactKinds } from '../src/runtime/inventory.js';
import { validateAdapter } from '../src/adapters/validate.js';
import { buildRecord } from '../src/sinks/format.js';
import { resolveOutput } from '../src/lib/outputs.js';

const here = dirname(fileURLToPath(import.meta.url));
const FULL = JSON.parse(readFileSync(join(here, '../../sources-repo/sources/openbank-es.json'), 'utf8'));
const EFF = resolveOutput(FULL, 'extracto-integrado');

// Synthetic Openbank statement list: two pages chained by `memento`, with `hasMore: "S"` until the last.
const item = (id, date) => ({ codComunicacion: id, fechaAlta: date, gestorDocumental: 'CD', codSubaplicacion: '00002209', nombreTipoComunicacion: 'EXTRACTO INTEGRADO' });
const PAGES = {
  '': { datos: { datos: [item('A001', '2026-06-30'), item('A002', '2026-05-31')] }, memento: 'm1', hasMore: 'S' },
  m1: { datos: { datos: [item('A003', '2026-04-30')] }, memento: 'm2', hasMore: 'N' }, // last page: hasMore N
};
const auth = { merged: { openbankauthtoken: 'eyJx' }, byPath: {}, ctx: {} };
let lastPdf = null;
const net = async (url) => {
  const u = new URL(url);
  if (u.pathname === '/extractos/comunicaciones-cursadas') {
    const p = PAGES[u.searchParams.get('memento') || ''];
    return { ok: true, status: 200, json: async () => (p || { datos: { datos: [] }, hasMore: 'N' }) };
  }
  if (u.pathname === '/extractos/documentos') { lastPdf = String(url); return { ok: true, status: 200, blob: async () => new Blob(['%PDF']), text: async () => '', headers: { get: () => 'application/pdf' } }; }
  return { ok: false, status: 404, json: async () => ({}) };
};

test('Openbank adapter validates', () => { assert.ok(validateAdapter(FULL).ok, JSON.stringify(validateAdapter(FULL))); });

test('cursor+hasMore pager follows memento across pages and stops when hasMore=N', async () => {
  const docs = await listInventory(EFF, auth, net, {});
  assert.equal(docs.length, 3); // both pages collected, then stops (hasMore=N)
  assert.deepEqual(docs.map((d) => d.internalId).sort(), ['A001', 'A002', 'A003']);
});

test('statement record maps codComunicacion/fechaAlta; PDF url resolves the doc params', async () => {
  const docs = await listInventory(EFF, auth, net, {});
  const rec = buildRecord(docs.find((d) => d.internalId === 'A001'), EFF);
  assert.equal(rec.internalId, 'A001'); assert.equal(rec.date, '2026-06-30'); assert.match(rec.description, /Extracto integrado 2026-06-30/);
  await fetchArtifact(EFF, auth, docs[0], net, null, artifactKinds(EFF, docs[0])[0].kind);
  assert.match(lastPdf, /\/extractos\/documentos\?gestorDocumental=CD&codigoSubaplicacion=00002209&codComunicacion=A00\d$/);
});
