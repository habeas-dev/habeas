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
const listCalls = []; // record each list request's query so we can assert the continuation-only param
const net = async (url) => {
  const u = new URL(url);
  if (u.pathname === '/extractos/comunicaciones-cursadas') {
    listCalls.push({ memento: u.searchParams.get('memento') || '', hasMorePagination: u.searchParams.get('hasMorePagination') });
    const p = PAGES[u.searchParams.get('memento') || ''];
    return { ok: true, status: 200, json: async () => (p || { datos: { datos: [] }, hasMore: 'N' }) };
  }
  if (u.pathname === '/extractos/documentos') { lastPdf = String(url); return { ok: true, status: 200, blob: async () => new Blob(['%PDF']), text: async () => '', headers: { get: () => 'application/pdf' } }; }
  return { ok: false, status: 404, json: async () => ({}) };
};

test('Openbank adapter validates', () => { assert.ok(validateAdapter(FULL).ok, JSON.stringify(validateAdapter(FULL))); });

test('cursor+hasMore pager follows memento across pages and stops when hasMore=N', async () => {
  listCalls.length = 0;
  const docs = await listInventory(EFF, auth, net, {});
  assert.equal(docs.length, 3); // both pages collected, then stops (hasMore=N)
  assert.deepEqual(docs.map((d) => d.internalId).sort(), ['A001', 'A002', 'A003']);
  // hasMorePagination is a CONTINUATION-only param (cursorParams): absent on the first call, present with the memento.
  assert.equal(listCalls[0].memento, ''); assert.equal(listCalls[0].hasMorePagination, null);
  assert.equal(listCalls[1].memento, 'm1'); assert.equal(listCalls[1].hasMorePagination, 'S');
});

test('statement record maps codComunicacion/fechaAlta; PDF url resolves the doc params', async () => {
  const docs = await listInventory(EFF, auth, net, {});
  const rec = buildRecord(docs.find((d) => d.internalId === 'A001'), EFF);
  assert.equal(rec.internalId, 'A001'); assert.equal(rec.date, '2026-06-30'); assert.match(rec.description, /Extracto integrado 2026-06-30/);
  await fetchArtifact(EFF, auth, docs[0], net, null, artifactKinds(EFF, docs[0])[0].kind);
  assert.match(lastPdf, /\/extractos\/documentos\?gestorDocumental=CD&codigoSubaplicacion=00002209&codComunicacion=A00\d$/);
});

test('extracto-integrado re-downloads from the store (keepRaw persists gestorDocumental/codSubaplicacion)', async () => {
  const docs = await listInventory(EFF, auth, net, {});
  const src = docs.find((d) => d.internalId === 'A001');
  // A row loaded back from the canonical store: only internalId + the persisted record survive.
  const stored = { internalId: src.internalId, record: src.record };
  assert.equal(stored.record.extra && stored.record.extra.gestorDocumental, 'CD', 'keepRaw persisted the download params');
  assert.ok(artifactKinds(EFF, stored).length, 'artifact is resolvable from the persisted record');
  lastPdf = null;
  await fetchArtifact(EFF, auth, stored, net, null, artifactKinds(EFF, stored)[0].kind);
  assert.match(lastPdf, /gestorDocumental=CD&codigoSubaplicacion=00002209&codComunicacion=A001$/);
});

// movimientos-doc: per-account × month statement download. Account params derive from the BBAN
// (codiban.codbban) in /posicion-global-total; the download URL packs them + a per-month date window,
// bounded to the last 90 days (Openbank's SCA cap — never attempt older ranges).
const MOV_EFF = resolveOutput(FULL, 'movimientos-doc/pdf');
// Wholly fictitious account: BBAN = entity(4)+branch(4)+control(2)+account(10).
// 0000 0000 99 1234500000 → control=99, producto=123, contrato=4500000, numeroCuenta=1234500000.
const POS = { datosSalidaCuentas: { cuentas: [
  { id: 'C1', descripcion: 'CUENTA DEMO', nombretitular: 'TITULAR DE PRUEBA ', codiban: { codbban: '00000000991234500000' } },
] } };
test('movimientos-doc derives account params from BBAN and builds per-month download URLs (90d)', async () => {
  let dlUrl = null; const creds = new Set();
  const mnet = async (url, init) => {
    creds.add(init && init.credentials);
    const u = new URL(url);
    if (u.pathname === '/posicion-global-total') return { ok: true, status: 200, json: async () => POS };
    if (u.pathname === '/cuentas/movimientos/descarga') { dlUrl = String(url); return { ok: true, status: 200, blob: async () => new Blob(['%PDF']), text: async () => '', headers: { get: () => 'application/pdf' } }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const docs = await listInventory(MOV_EFF, auth, mnet, {});
  assert.ok(docs.length >= 1 && docs.length <= 4, `~3 months in 90d window, got ${docs.length}`);
  assert.match(docs[0].internalId, /^1234500000-\d{4}-\d{2}$/);
  await fetchArtifact(MOV_EFF, auth, docs[0], mnet, null, artifactKinds(MOV_EFF, docs[0])[0].kind);
  const u = new URL(dlUrl);
  assert.equal(u.pathname, '/cuentas/movimientos/descarga');
  assert.equal(u.searchParams.get('digitoControl'), '99');
  assert.equal(u.searchParams.get('producto'), '123');
  assert.equal(u.searchParams.get('contrato'), '4500000');
  assert.equal(u.searchParams.get('numeroCuenta'), '1234500000');
  assert.equal(u.searchParams.get('tipoArchivo'), 'p');
  assert.equal(u.searchParams.get('titular'), 'TITULAR DE PRUEBA'); // trimmed
  assert.match(u.searchParams.get('fechaDesde'), /^\d{4}-\d{2}-01$/);
  assert.match(u.searchParams.get('fechaHasta'), /^\d{4}-\d{2}-\d{2}$/);
  // auth.cookies:false → every request omits the cookie jar (Openbank rejects the big cookie header, HTTP 413).
  assert.ok(creds.has('omit') && !creds.has('include'), `expected credentials omit only, saw ${[...creds]}`);
});

test('movimientos-doc re-downloads from the store (no _group/_raw — rebuilt from record.extra)', async () => {
  let dlUrl = null;
  const mnet = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/posicion-global-total') return { ok: true, status: 200, json: async () => POS };
    if (u.pathname === '/cuentas/movimientos/descarga') { dlUrl = String(url); return { ok: true, status: 200, blob: async () => new Blob(['%PDF']), text: async () => '', headers: { get: () => 'application/pdf' } }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const docs = await listInventory(MOV_EFF, auth, mnet, {});
  // Simulate a row loaded back from the canonical store: ONLY internalId + the persisted record survive
  // (the transient _group/_raw are gone). keepRaw must have captured everything the download URL needs.
  const stored = { internalId: docs[0].internalId, record: docs[0].record };
  assert.ok(stored.record.extra && stored.record.extra.digitoControl === '99', 'keepRaw persisted the derived account fields into record.extra');
  await fetchArtifact(MOV_EFF, auth, stored, mnet, null, artifactKinds(MOV_EFF, stored)[0].kind);
  const u = new URL(dlUrl);
  assert.equal(u.searchParams.get('numeroCuenta'), '1234500000');
  assert.equal(u.searchParams.get('digitoControl'), '99');
  assert.equal(u.searchParams.get('titular'), 'TITULAR DE PRUEBA');
  assert.match(u.searchParams.get('fechaDesde'), /^\d{4}-\d{2}-01$/);
  assert.match(u.searchParams.get('fechaHasta'), /^\d{4}-\d{2}-\d{2}$/);
});

// movimientos (transaction stream): per-account movements, paged by a full-URL `_links.nextPage.href`
// (not a bare cursor), bounded to a 90-day window, and STOPPING at the SCA boundary (scaRequired) so no
// SMS/OTP is ever triggered. Wholly fictitious data.
const MV_EFF = resolveOutput(FULL, 'movimientos');
const mvItem = (dia, imp, concepto) => ({ fechaOperacion: '2026-06-26', fechaValor: '2026-06-26', diaMvto: dia, nummov: 1, importe: { importe: imp, divisa: 'EUR' }, saldo: { importe: 1000, divisa: 'EUR' }, conceptoTabla: concepto });
test('movimientos: full-URL nextPage pager, transaction mapping, and SCA stop', async () => {
  // Page 1 = the FLAT first-call shape Openbank actually returns (movimientos at the top level, scaRequired false).
  const P1 = { _links: { nextPage: { href: 'http://api.openbank.es:80/my-money/cuentas/movimientos?producto=123&numeroContrato=4500000&pag=2' } }, movimientos: [mvItem(3, -50, 'COMPRA EN TIENDA DEMO'), mvItem(2, 200, 'TRANSFERENCIA DE JUAN PEREZ, CONCEPTO regalo')], masMovimientos: true, scaRequired: false };
  // Page 2 = the PAGINATED shape (nested under methodResult), and it flags the SCA boundary → collect then STOP.
  const P2 = { _links: { nextPage: { href: 'http://api.openbank.es:80/my-money/cuentas/movimientos?pag=3' } }, methodResult: { movimientos: [mvItem(1, -12.5, 'RECIBO LUZ')] }, masMovimientos: true, scaRequired: true };
  let hitHttp = false, page2Https = false;
  const net = async (url) => {
    const u = new URL(url);
    if (url.startsWith('http://')) hitHttp = true; // the pager must have normalised http:80 → https
    if (u.pathname === '/posicion-global-total') return { ok: true, status: 200, json: async () => POS };
    if (u.pathname === '/my-money/cuentas/movimientos') {
      if (u.searchParams.get('pag') === '2') { page2Https = url.startsWith('https://'); return { ok: true, status: 200, json: async () => P2 }; }
      return { ok: true, status: 200, json: async () => P1 };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const docs = await listInventory(MV_EFF, auth, net, {});
  assert.equal(hitHttp, false, 'nextPage href must be fetched over https, never http');
  assert.equal(page2Https, true, 'page 2 followed via https');
  assert.equal(docs.length, 3, 'page 1 (2) + page 2 (1, scaRequired) collected, then STOP'); // does not page past SCA
  const byId = Object.fromEntries(docs.map((d) => [d.record.description.trim(), d.record]));
  assert.equal(byId['COMPRA EN TIENDA DEMO'].amount, -50);
  assert.equal(byId['COMPRA EN TIENDA DEMO'].direction, 'debit');
  assert.equal(byId['COMPRA EN TIENDA DEMO'].currency, 'EUR');
  const juan = docs.find((d) => /JUAN PEREZ/.test(d.record.description));
  assert.equal(juan.record.direction, 'credit');
  assert.equal(juan.record.counterparty, 'JUAN PEREZ', 'counterparty extracted, stops at the comma');
  assert.equal(new Set(docs.map((d) => d.internalId)).size, 3, 'stable unique ids');
});

test('keepAlive pings /token/keepalive during paging and swaps in the fresh token', async () => {
  const inv = await import('../src/runtime/inventory.js?kaisolated'); // fresh module → fresh keep-alive timer
  let kaCalls = 0; const FRESH = 'eyJfreshtoken';
  const auth2 = { merged: { openbankauthtoken: 'eyJold' }, byPath: { '/my-money/cuentas/movimientos': { openbankauthtoken: 'eyJold' } }, ctx: {} };
  const net = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/token/keepalive') { kaCalls++; assert.equal(init.method, 'POST'); return { ok: true, status: 200, json: async () => ({ expiration: 300, tokenCredential: FRESH }) }; }
    if (u.pathname === '/posicion-global-total') return { ok: true, status: 200, json: async () => POS };
    if (u.pathname === '/my-money/cuentas/movimientos') return { ok: true, status: 200, json: async () => ({ methodResult: { movimientos: [mvItem(1, -5, 'COMPRA X')] }, masMovimientos: false, scaRequired: false }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await inv.listInventory(resolveOutput(FULL, 'movimientos'), auth2, net, {});
  assert.ok(kaCalls >= 1, 'keepalive was pinged during listing');
  assert.equal(auth2.merged.openbankauthtoken, FRESH, 'fresh token swapped into merged auth');
  assert.equal(auth2.byPath['/my-money/cuentas/movimientos'].openbankauthtoken, FRESH, 'fresh token swapped into byPath auth');
});
