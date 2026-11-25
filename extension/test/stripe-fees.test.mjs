// Stripe's monthly fee invoices: the only Stripe documents with no API (they live in the dashboard, as PDFs).
// The source lists them with the dashboard's own session (an opaque `uk_` bearer + Stripe-Account +
// Stripe-Livemode — the minimum the endpoint accepts), takes the open account from /v1/accounts/{id}, and
// downloads each PDF through the dashboard's /download link (which redirects to a signed S3 URL).
//
// Shaped like the real responses; every value is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory, fetchPdf } from '../src/runtime/inventory.js';
import { validateAdapter } from '../src/adapters/validate.js';
import { buildRecord } from '../src/sinks/format.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = JSON.parse(readFileSync(join(ROOT, 'sources-repo/sources/stripe-fees.json'), 'utf8'));
const ACCT = 'acct_000000EXAMPLE1';
const HDRS = { authorization: 'Bearer uk_EXAMPLEEXAMPLEEXAMPLEEXAMPLE', 'stripe-account': ACCT, 'stripe-livemode': 'true' };
const AUTH = { merged: HDRS, byPath: {}, ctx: { acct: ACCT } };
const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
const utc = (iso) => Date.parse(iso) / 1000;

const item = (month, mm, issued, extra = {}) => ({
  token: 'vati_EXAMPLE' + mm, invoiceNumber: 'EXAMPLE1-2026-' + mm, description: 'Tax Invoice for ' + month + ' 2026',
  title: 'Tax Invoice', documentCategory: 'Tax Invoice', type: 'vat_invoice', invoiceType: 'common', invoiceLegalEntity: 'ES',
  createdString: issued, created: utc(issued + 'T06:00:00Z'), generated_at: utc(issued + 'T06:00:00Z'),
  periodStartInclusive: utc('2026-' + mm + '-01T00:00:00Z'), periodEndExclusive: utc('2026-' + mm + '-30T23:59:59Z'),
  reverseCharge: false, corrected: false, credited: null, downloadLinkAvailable: true,
  link: '/download/tax/vat/vati_EXAMPLE' + mm, livemode: true, version: 1, hidden: false,
  regenerationDetails: { vatId: 'ESX0000000X', tds: null, italy_regenerate: null }, ...extra,
});
const LIST = { data: [item('September', '09', '2026-10-05'), item('June', '06', '2026-07-05', { reverseCharge: true })], has_more: false, total_count: 2, url: '/v1/settings/plans_and_fees/invoice_history_documents' };
const ACCOUNT = { id: ACCT, object: 'account', country: 'ES', settings: { dashboard: { display_name: 'Demo shop' } }, business_profile: { name: 'Demo shop SL' } };

function net() {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/accounts/' + ACCT)) return ok(ACCOUNT);
    if (url.includes('/v1/settings/plans_and_fees/invoice_history_documents')) return ok(LIST);
    if (url.includes('/download/tax/vat/')) return { ok: true, status: 200, blob: async () => new Blob(['%PDF-1.4 example']), text: async () => '' };
    return { ok: false, status: 404, text: async () => 'unexpected ' + url };
  };
  return { fn, calls };
}

test('stripe-fees: the definition validates', () => {
  const v = validateAdapter(SRC);
  assert.deepEqual(v.errors || [], []);
});

test('stripe-fees: lists the open account\'s fee invoices as invoice@2 received records', async () => {
  const n = net();
  const docs = await listInventory(SRC, AUTH, n.fn);
  assert.equal(docs.length, 2);
  const list = n.calls.find((c) => c.url.includes('invoice_history_documents'));
  assert.equal(list.url, 'https://dashboard.stripe.com/v1/settings/plans_and_fees/invoice_history_documents');
  for (const h of ['authorization', 'stripe-account', 'stripe-livemode']) assert.equal(list.init.headers[h], HDRS[h], h);

  const r = buildRecord(docs.find((d) => d.internalId === 'vati_EXAMPLE09'), SRC);
  assert.equal(r._schema, 'invoice@2');
  assert.equal(r.flow, 'received');
  assert.equal(r.number, 'EXAMPLE1-2026-09');
  assert.equal(r.issueDate, '2026-10-05');
  assert.deepEqual(r.servicePeriod, { start: '2026-09-01', end: '2026-09-30' });
  assert.equal(r.recipientTaxId, 'ESX0000000X');
  assert.equal(r.reverseCharge, false);
  assert.equal(r.corrected, false);
  assert.equal(r.issuer.name, 'Stripe Payments Europe, Limited');
  assert.equal(r.issuer.country, 'IE');
  assert.deepEqual(r.account, { id: ACCT, label: 'Demo shop' });
  assert.equal(r.category, 'banking');
  for (const k of ['total', 'subtotal', 'currency', 'taxes']) assert.ok(!(k in r), k + ' must be absent');

  assert.equal(buildRecord(docs.find((d) => d.internalId === 'vati_EXAMPLE06'), SRC).reverseCharge, true);
});

test('stripe-fees: the PDF is fetched through the dashboard /download link with the session', async () => {
  const n = net();
  const docs = await listInventory(SRC, AUTH, n.fn);
  const blob = await fetchPdf(SRC, AUTH, docs[0], n.fn);
  assert.ok(blob);
  const dl = n.calls.find((c) => c.url.includes('/download/'));
  assert.equal(dl.url, 'https://dashboard.stripe.com/download/tax/vat/' + docs[0].internalId);
  assert.equal(dl.init.credentials, 'include'); // the redirect to the signed S3 URL needs the dashboard cookies
  // Verified live: without Stripe-Account the download answers 404 {"code":"not_found"}; with it, 302 to S3.
  assert.equal(dl.init.headers['stripe-account'], ACCT);
});
