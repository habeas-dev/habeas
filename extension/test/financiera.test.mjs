import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory, tmplDates, fetchPdf } from '../src/runtime/inventory.js';
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

test('tmplDates: computed calendar-date tokens, ISO by default and formatted with :FORMAT', () => {
  const now = new Date();
  const me = new Date(now.getFullYear(), now.getMonth() + 1, 0); // last day of the current month
  const DD = String(me.getDate()).padStart(2, '0'), MM = String(me.getMonth() + 1).padStart(2, '0'), YYYY = String(me.getFullYear());
  assert.equal(tmplDates('date_bill={monthEnd:DD/MM/YYYY}'), `date_bill=${DD}/${MM}/${YYYY}`);
  assert.equal(tmplDates('{monthStart:DD/MM/YYYY}'), `01/${MM}/${YYYY}`);
  assert.match(tmplDates('{today}'), /^\d{4}-\d{2}-\d{2}$/); // ISO by default
  assert.equal(tmplDates('no tokens here'), 'no tokens here');
});

test('aplazamientos: sends the SPA pagination params (page_number/page_size)', async () => {
  let url = '';
  const net = async (u) => {
    if (u.endsWith('/dashboard/user')) return okJson({ userEciCardList: [CARD] });
    if (u.includes('/financing-purchases')) { url = u; return okJson({ financing_data: [{ identifier: 'F1', start_date: '2020-01-01', financing_type: 'STANDARD' }] }); }
    return miss;
  };
  const docs = await listInventory(resolveOutput(ADP, 'aplazamientos'), { merged: {}, byPath: {}, ctx: {} }, net, {});
  assert.ok(url.includes('/card-contracts/C0001/financing-purchases'), url);
  assert.ok(url.includes('page_number=0') && url.includes('page_size=100'), 'paged params sent: ' + url);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].internalId, 'F1');
});

test('extractos: sends date_bill as the current month-end in DD/MM/YYYY', async () => {
  const now = new Date();
  const me = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const expect = `${String(me.getDate()).padStart(2, '0')}/${String(me.getMonth() + 1).padStart(2, '0')}/${me.getFullYear()}`;
  let url = '';
  const net = async (u) => {
    if (u.endsWith('/dashboard/user')) return okJson({ userEciCardList: [CARD] });
    if (u.includes('/shopping-summaries')) { url = u; return okJson({ previous_months_shopping_summaries: [{ date: '2020-05', description: 'Extracto mayo' }] }); }
    return miss;
  };
  const docs = await listInventory(resolveOutput(ADP, 'extractos'), { merged: {}, byPath: {}, ctx: {} }, net, {});
  assert.ok(url.includes('date_bill='), 'date_bill present: ' + url);
  assert.ok(url.includes('date_bill=' + encodeURIComponent(expect)), 'date_bill is the current month-end DD/MM/YYYY: ' + url);
  assert.equal(docs.length, 1);
});

test('extractos: statement PDF is a POST generate-file with {} body + json, base64 file decoded', async () => {
  const EFF = resolveOutput(ADP, 'extractos');
  const REAL = '%PDF-1.4 extracto demo\n%%EOF';
  const B64 = Buffer.from(REAL).toString('base64');
  let url = null, sent = null;
  globalThis.fetch = async (u, i) => { url = String(u); sent = i; return { ok: true, status: 200, text: async () => JSON.stringify({ file: B64 }) }; };
  // a listed statement doc: {date} comes from the RAW item (DD/MM/YYYY, as the API returns it), not the ISO record
  const doc = { internalId: '01/08/2022', _raw: { date: '01/08/2022', description: 'Extracto' }, _group: { id: 'C0001', pan: 'AbC+dEf/gHi012=' } };
  const blob = await fetchPdf(EFF, { merged: {}, byPath: {}, ctx: {} }, doc);
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), REAL, 'base64 file decoded round-trip');
  assert.ok(url.includes('/contracts/C0001/shopping-summaries/generate-file'), url);
  assert.ok(url.includes('datePurchase=01/08/2022'), 'datePurchase = the raw item date, verbatim (slashes not encoded): ' + url);
  assert.equal(sent.method, 'POST');
  assert.equal(sent.body, '{}');
  assert.match(String(sent.headers['content-type']), /application\/json/);
  assert.equal(sent.headers['eci-custom-encrypted-pan'], 'AbC+dEf/gHi012=', 'per-card PAN header sent VERBATIM (base64 not URL-encoded)');
});
