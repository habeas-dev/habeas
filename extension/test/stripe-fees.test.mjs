// Stripe's monthly fee invoices: the only Stripe documents with no API (they live in the dashboard, as PDFs).
// The source lists them with the dashboard's own session (an opaque `uk_` bearer + Stripe-Account +
// Stripe-Livemode — the minimum the endpoint accepts) for EVERY account in the user's profile, not only the one
// open: the dashboard's own GraphQL query V2GetUserAccessibleAccountsQuery names them, and the same session
// lists any of them by changing Stripe-Account (verified live: the invoices were in an account other than the
// open one). Each PDF downloads through the dashboard's /download link with its own account's header.
//
// Shaped like the real responses; every value is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory, listGroups, fetchPdf } from '../src/runtime/inventory.js';
import { validateAdapter } from '../src/adapters/validate.js';
import { buildRecord } from '../src/sinks/format.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = JSON.parse(readFileSync(join(ROOT, 'sources-repo/sources/stripe-fees.json'), 'utf8'));
const ACCT = 'acct_000000EXAMPLE1';
const HDRS = { authorization: 'Bearer uk_EXAMPLEEXAMPLEEXAMPLEEXAMPLE', 'stripe-account': 'acct_000000EXAMPLE2', 'stripe-livemode': 'true' };
const AUTH = { merged: HDRS, byPath: { '/v1/settings/plans_and_fees/invoice_history_documents': HDRS } };
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
// The profile: the account with the invoices (ACCT), an open one with none (OPEN — the captured header), and an
// Express account (a connected account another platform bills, with no Stripe fee invoices of its own).
const OPEN = 'acct_000000EXAMPLE2';
const EXPRESS = 'acct_000000EXAMPLE3';
const ACCOUNTS = { data: { v2GetUserAccessibleAccounts: {
  organizations: [],
  standalone_merchants: [{ name: 'Demo person', merchant_id: EXPRESS, dashboard_type: 'express', platform_nickname: 'Some platform' }],
  standalone_workspaces: [
    { name: 'Other shop', merchant_id: OPEN, dashboard_type: 'full' },
    { name: 'Demo shop', merchant_id: ACCT, dashboard_type: 'full' },
  ],
} } };

function net() {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('/graphql/multiregion')) return ok(ACCOUNTS);
    if (url.includes('/v1/settings/plans_and_fees/invoice_history_documents')) return ok(init.headers['stripe-account'] === ACCT ? LIST : { data: [], has_more: false });
    if (url.includes('/download/tax/vat/')) return { ok: true, status: 200, blob: async () => new Blob(['%PDF-1.4 example']), text: async () => '' };
    return { ok: false, status: 404, text: async () => 'unexpected ' + url };
  };
  return { fn, calls };
}

test('stripe-fees: the definition validates', () => {
  const v = validateAdapter(SRC);
  assert.deepEqual(v.errors || [], []);
});

test('stripe-fees: the accounts are every full-dashboard account of the profile, from the dashboard\'s own query', async () => {
  const n = net();
  const groups = await listGroups(SRC, AUTH, n.fn);
  assert.deepEqual(groups.map((g) => [g.id, g.label]), [[OPEN, 'Other shop'], [ACCT, 'Demo shop']]); // Express left out
  const q = n.calls.find((c) => c.url.includes('/graphql/multiregion'));
  assert.equal(q.url, 'https://dashboard.stripe.com/graphql/multiregion?name=V2GetUserAccessibleAccountsQuery');
  assert.equal(q.init.method, 'POST');
  // Verified live: without X-Requested-With the endpoint answers 400 csrf_invalid_request; without
  // Stripe-Version, "Please specify an API version"; the session key is the same uk_ bearer.
  assert.equal(q.init.headers['x-requested-with'], 'XMLHttpRequest');
  assert.ok(q.init.headers['stripe-version']);
  assert.equal(q.init.headers['content-type'], 'application/json');
  assert.equal(q.init.headers.authorization, HDRS.authorization);
  const body = JSON.parse(q.init.body);
  assert.equal(body.operationName, 'V2GetUserAccessibleAccountsQuery');
  assert.match(body.query, /v2GetUserAccessibleAccounts\(context: \$v2Context\)/);
});

test('stripe-fees: lists every account\'s fee invoices (not only the open one) as invoice@2 received records', async () => {
  const n = net();
  const docs = await listInventory(SRC, AUTH, n.fn);
  assert.equal(docs.length, 2);
  const lists = n.calls.filter((c) => c.url.includes('invoice_history_documents'));
  assert.deepEqual(lists.map((c) => c.init.headers['stripe-account']), [OPEN, ACCT]); // each with ITS account
  assert.equal(lists[0].url, 'https://dashboard.stripe.com/v1/settings/plans_and_fees/invoice_history_documents');
  for (const h of ['authorization', 'stripe-livemode']) assert.equal(lists[1].init.headers[h], HDRS[h], h);

  const r = buildRecord(docs.find((d) => d.internalId === 'vati_EXAMPLE09'), SRC);
  assert.equal(r._schema, 'invoice@2');
  assert.equal(r.flow, 'received');
  assert.equal(r.number, 'EXAMPLE1-2026-09');
  // The PDF's Invoice Date is the LAST day of the service month (verified on three real invoices), not the day
  // Stripe generates it (createdString, the 5th of the next month) — which matters for the VAT quarter.
  assert.equal(r.issueDate, '2026-09-30');
  assert.equal(r.extra.generatedDate, '2026-10-05');
  assert.equal(r.issuer.taxId, 'IE3206488LH');
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
