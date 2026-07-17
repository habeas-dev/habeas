// The capture-replay harness: runs an adapter's runtime against a handoff's captured samples and reports,
// per output, whether it lists + fetches documents — catching requests the adapter builds that the SPA never
// made (missing query params / POST body → hard fail; a header the SPA also sent → warning, since a header
// can't be proven required from a capture). All values here are SYNTHETIC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { replayCapture } from '../../scripts/replay-capture.mjs';

const HOST = 'https://www.feci.test';
const PDF_B64 = Buffer.from('%PDF-1.4 demo\n%%EOF').toString('base64');

// A FECI-shaped adapter (grouped by card, a paged loan list, and a statement list whose PDF is a POST
// generate-file needing the card's own header). `opts` injects the specific bugs we want to catch.
const adapter = (opts = {}) => ({
  id: 'feci-demo', service: 'feci', trust: 'community', domain: 'feci.test', match: [HOST + '/*'], auth: { mode: 'cookie' },
  api: { host: HOST, groups: { path: '/user', itemsPath: 'cards', fields: { id: 'contract_number', pan: 'encryptedPan', mask: 'masked_pan' } } },
  streams: [
    { id: 'aplazamientos', schema: 'transaction@1', api: { list: { path: '/cards/{group.id}/financing-purchases', params: opts.aplzNoParams ? {} : { page_number: '0', page_size: '100' }, itemsPath: 'financing_data', paging: 'none' } }, fields: { internalId: 'identifier', date: 'start_date', type: 'financing_type' } },
    { id: 'extractos', schema: 'invoice@1', api: {
      list: { path: '/docs/{group.id}/shopping-summaries', params: opts.extNoDateBill ? {} : { date_bill: '{monthEnd:DD/MM/YYYY}' }, itemsPath: 'previous_months_shopping_summaries', paging: 'none' },
      pdf: { path: '/docs/{group.id}/shopping-summaries/generate-file?datePurchase={date}', method: 'POST', ...(opts.pdfNoBody ? {} : { body: '{}' }), contentType: 'application/json', ...(opts.pdfNoHeader ? {} : { headers: { 'eci-custom-encrypted-pan': '{group.pan}' } }), base64Field: 'file', ext: 'pdf' },
    }, fields: { internalId: 'date', date: 'date', number: 'description' } },
  ],
});

const bundle = (fileVal = PDF_B64) => ({ samples: [
  { url: HOST + '/user', method: 'GET', json: { cards: [{ contract_number: 'C1', encryptedPan: 'PAN1', masked_pan: '**** 0001' }] } },
  { url: HOST + '/cards/C1/financing-purchases?page_number=0&page_size=100', method: 'GET', reqHeaders: { 'eci-custom-encrypted-pan': 'PAN1' }, json: { financing_data: [{ identifier: 'F1', start_date: '2020-01-01', financing_type: 'STD' }] } },
  { url: HOST + '/docs/C1/shopping-summaries?date_bill=31/07/2026', method: 'GET', reqHeaders: { 'eci-custom-encrypted-pan': 'PAN1' }, json: { previous_months_shopping_summaries: [{ date: '01/08/2022', description: 'Extracto' }, '[+24 more]'] } },
  { url: HOST + '/docs/C1/shopping-summaries/generate-file?datePurchase=01/08/2022', method: 'POST', reqBody: '{}', reqHeaders: { 'eci-custom-encrypted-pan': 'PAN1', 'content-type': 'application/json' }, json: { file: fileVal } },
] });

const byId = (rep) => Object.fromEntries(rep.outputs.map((o) => [o.id, o]));

test('a correct adapter passes every output against the capture (incl. the POST-generated PDF)', async () => {
  const rep = await replayCapture(bundle(), adapter());
  assert.equal(rep.ok, true, JSON.stringify(rep.outputs));
  const o = byId(rep);
  assert.equal(o.aplazamientos.listed, 1);
  assert.equal(o.extractos.listed, 2);       // includes the truncation marker element
  assert.equal(o.extractos.docOk, true);     // PDF fetched + base64 decoded, on the REAL item (marker skipped)
});

test('missing query param is a hard failure with the exact param named', async () => {
  const rep = await replayCapture(bundle(), adapter({ extNoDateBill: true }));
  const o = byId(rep);
  assert.equal(o.extractos.ok, false);
  assert.ok(o.extractos.issues.some((i) => i.includes('date_bill')), JSON.stringify(o.extractos.issues));
  const rep2 = await replayCapture(bundle(), adapter({ aplzNoParams: true }));
  assert.ok(byId(rep2).aplazamientos.issues.some((i) => /page_number|page_size/.test(i)));
});

test('missing POST body is a hard failure', async () => {
  const rep = await replayCapture(bundle(), adapter({ pdfNoBody: true }));
  const o = byId(rep).extractos;
  assert.equal(o.docOk, false);
  assert.ok(o.issues.some((i) => /request body/.test(i)), JSON.stringify(o.issues));
});

test('a header the SPA also sent is a WARNING, not a failure (cannot be proven required)', async () => {
  const rep = await replayCapture(bundle(), adapter({ pdfNoHeader: true }));
  const o = byId(rep).extractos;
  assert.equal(o.ok, true); // still passes (the list works without it; the PDF here decodes)
  assert.ok(o.warnings.some((w) => w.includes('eci-custom-encrypted-pan')), JSON.stringify(o.warnings));
});

test('a redacted base64 payload is tolerated: request verified, bytes not decoded', async () => {
  const rep = await replayCapture(bundle('[amount:MXN]'), adapter()); // file value redacted by the anonymizer
  const o = byId(rep).extractos;
  assert.equal(o.docOk, true); // the generate-file request matched the capture; only the redacted bytes fail
  assert.ok(o.warnings.some((w) => /redacted/.test(w)));
});
