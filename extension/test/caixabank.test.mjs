// CaixaBank Consumer — extractos (statements). Exercises the general runtime/capture additions
// this source needs: a captured "context" value (the DNI) templated into the groups path + list
// body, groups enumerated from a JSON listaProductos, a POST list with a JSON body + date window,
// and an ABSOLUTE-URL document (each statement's `Url` is a full https:// link fetched as-is).
// All values here are INVENTED — never the user's real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory, fetchDocument, fetchPdf, normalizeDate } from '../src/runtime/inventory.js';
import { validateAdapter, checkHosts } from '../src/adapters/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = JSON.parse(readFileSync(join(here, '../../sources-repo/sources/caixabank-consumer-es.json'), 'utf8'));

// Invented session: an opaque (non-JWT) bearer token, and the captured DNI context value.
const DNI = '00000000T';
const auth = { byPath: {}, merged: { authorization: 'Bearer 00000000-0000-4000-8000-000000000000-0badc0de' }, ctx: { dni: DNI } };

// Two invented card contracts; two invented statements each with a FULL absolute PDF Url.
const POSICION = {
  listaProductos: [
    { numeroContrato: 'C1', marca: 'WY', marcaDescripcion: 'TEST VISA', numeroTarjeta: '**** **** **** 1111' },
    { numeroContrato: 'C2', marca: 'WZ', marcaDescripcion: 'TEST ORO', numeroTarjeta: '**** **** **** 2222' },
  ],
};
const EXTRACTOS = {
  C1: { Extractos: [
    { Codigo: 'EXTR-C1-A', Contrato: 'C1', Marca: 'WY', FechaDesde: '2024/01/21', FechaHasta: '2024/02/20', Nombre: 'INVENTED', Url: 'https://api.caixabankpc.com/cpc/v2.0/cgi/extractos/consulta/CONTRATO=C1&HPARA=aaaa' },
    { Codigo: 'EXTR-C1-B', Contrato: 'C1', Marca: 'WY', FechaDesde: '2024/02/21', FechaHasta: '2024/03/20', Nombre: 'INVENTED', Url: 'https://api.caixabankpc.com/cpc/v2.0/cgi/extractos/consulta/CONTRATO=C1&HPARA=bbbb' },
  ] },
  C2: { Extractos: [
    { Codigo: 'EXTR-C2-A', Contrato: 'C2', Marca: 'WZ', FechaDesde: '2024/01/10', FechaHasta: '2024/02/09', Nombre: 'INVENTED', Url: 'https://api.caixabankpc.com/cpc/v2.0/cgi/extractos/consulta/CONTRATO=C2&HPARA=cccc' },
  ] },
};

function mockNet() {
  const calls = [];
  const net = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/posicionGlobal/')) return { ok: true, status: 200, json: async () => POSICION };
    if (String(url).includes('/extractos/consultaonline')) {
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => EXTRACTOS[body.Contrato] || { Extractos: [] } };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  return { net, calls };
}

test('DNI context is templated into the groups path and the list POST body; groups + statements enumerate', async () => {
  const { net, calls } = mockNet();
  const docs = await listInventory(SRC, auth, net);

  // groups GET: {ctx.dni} filled into /posicionGlobal/es/<DNI>
  const groupsCall = calls.find((c) => c.url.includes('/posicionGlobal/'));
  assert.ok(groupsCall, 'made the posicionGlobal groups request');
  assert.ok(groupsCall.url.endsWith('/posicionGlobal/es/' + DNI), 'DNI templated into groups path: ' + groupsCall.url);
  assert.ok(!/\{ctx\./.test(groupsCall.url), 'no leftover {ctx.*} in the groups URL');

  // list POST bodies: {ctx.dni} + {group.numeroContrato} + {group.marca} + date window
  const listCalls = calls.filter((c) => c.url.includes('/extractos/consultaonline'));
  assert.equal(listCalls.length, 2, 'one statements request per contract (C1, C2)');
  const b1 = JSON.parse(listCalls[0].init.body);
  assert.equal(b1.DNI, DNI);
  assert.equal(b1.Contrato, 'C1');
  assert.equal(b1.Marca, 'WY');
  assert.match(b1.FechaDesde, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(b1.FechaHasta, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(new Date(b1.FechaHasta) > new Date(b1.FechaDesde), 'a real date window');
  assert.equal(listCalls[0].init.headers['content-type'], 'application/json');
  // the opaque bearer is replayed to the (cross-domain) API host
  assert.match(listCalls[0].init.headers.authorization, /^Bearer /);

  // 3 statements total; internalId = Codigo; date "YYYY/MM/DD" normalized to ISO
  assert.equal(docs.length, 3);
  assert.deepEqual(docs.map((d) => d.internalId).sort(), ['EXTR-C1-A', 'EXTR-C1-B', 'EXTR-C2-A']);
  assert.ok(docs.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)));
  const c1a = docs.find((d) => d.internalId === 'EXTR-C1-A');
  assert.equal(c1a.date, '2024-02-20');
});

test('absolute-Url document: the statement PDF is fetched from the item\'s full https Url as-is', async () => {
  let hit = null;
  const net = async (url, init) => { hit = { url: String(url), init }; return { ok: true, status: 200, blob: async () => new Blob(['%PDF-invented']) }; };
  const doc = { internalId: 'EXTR-C1-A', _raw: EXTRACTOS.C1.Extractos[0] };
  const { blob, ext, via } = await fetchDocument(SRC, auth, doc, net);
  assert.equal(ext, 'pdf');
  assert.equal(via, 'pdf');
  assert.equal(hit.url, 'https://api.caixabankpc.com/cpc/v2.0/cgi/extractos/consulta/CONTRATO=C1&HPARA=aaaa', 'fetched the absolute Url verbatim (no api.host prefix)');
  assert.match(hit.init.headers.authorization, /^Bearer /); // bearer replayed
  assert.ok(await blob.text());
});

test('absolute-Url guard: an item Url pointing off the allowed hosts is rejected', async () => {
  const net = async () => ({ ok: true, status: 200, blob: async () => new Blob(['x']) });
  const evil = { internalId: 'X', _raw: { Url: 'https://evil.example.com/steal?t=1' } };
  await assert.rejects(() => fetchPdf(SRC, auth, evil, net), /host not allowed|not allowed/i);
});

test('the shipped source is valid; the cross-domain API host is allowed ONLY via crossDomainHosts', () => {
  const v = validateAdapter(SRC);
  assert.ok(v.ok, 'validateAdapter passes: ' + v.errors.join('; '));
  assert.equal(SRC.trust, 'first-party');
  assert.deepEqual(SRC.crossDomainHosts, ['api.caixabankpc.com']);

  const h = checkHosts(SRC);
  assert.ok(h.ok, 'checkHosts ok with the allowlist');
  assert.ok(h.crossDomain.includes('caixabankpc.com'), 'cross-domain registrable domain surfaced for consent');

  // Remove the allowlist → the API host becomes an offender → hard reject.
  const without = JSON.parse(JSON.stringify(SRC));
  delete without.crossDomainHosts;
  const h2 = checkHosts(without);
  assert.ok(!h2.ok, 'without crossDomainHosts the cross-domain API host is rejected');
  assert.ok(h2.offenders.some((o) => o.includes('caixabankpc.com')));
  assert.ok(!validateAdapter(without).ok, 'validateAdapter also rejects it');
});

test('normalizeDate handles the CaixaBank "YYYY/MM/DD" statement dates', () => {
  assert.equal(normalizeDate('2024/02/20'), '2024-02-20');
  assert.equal(normalizeDate('2021/07/21'), '2021-07-21');
});
