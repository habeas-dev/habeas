// A fake STRIPE DASHBOARD for end-to-end tests of the Stripe fee-invoice source and of the apps that consume
// it (Cuéntamo's received-invoices inbox). It behaves like the real dashboard where it matters to Habeas:
//  - a logged-in SPA that calls its API with an opaque session key (`Bearer uk_…`), `Stripe-Account` and
//    `Stripe-Livemode` — the three headers the real endpoint needs — and loads the open account from
//    /v1/accounts/{id};
//  - GET /v1/settings/plans_and_fees/invoice_history_documents → every fee invoice, no pagination, NO amounts
//    (the real list carries none: they are only in the PDF);
//  - GET /download/tax/vat/{token} → a redirect to the stored PDF (the real one redirects to a signed S3 URL;
//    here it stays on loopback, so the off-site hop itself is not exercised).
// Same field names as the real responses; every value is invented.
//
// TEST ONLY. Never shipped nor published (the validator allows http only for localhost).
//   POST /__control/invoice {month: "2026-10", reverseCharge?} → appends that month's fee invoice
//   POST /__control/reset                                      → back to the fixed data set
import http from 'node:http';

export const FAKE_STRIPE_ACCOUNT = 'acct_000000FAKEE2E1';
export const FAKE_STRIPE_ACCOUNT_NAME = 'Fake Shop (E2E)';
export const FAKE_STRIPE_TAX_ID = 'ESX0000000X';
const KEY = 'Bearer uk_FAKEE2EFAKEE2EFAKEE2EFAKEE2EFAKE';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
const SUFFIX = FAKE_STRIPE_ACCOUNT.slice(-8).toUpperCase();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// One fee invoice for a billed month "YYYY-MM": issued on the 5th of the next month, numbered
// <last 8 of the account, upper case>-YYYY-MM, its period end given as the last second of the month (as the
// real list does).
function invoice(month, { reverseCharge = false } = {}) {
  const [y, m] = month.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1) / 1000;
  const end = Date.UTC(y, m, 1) / 1000 - 1;
  const issued = new Date(Date.UTC(y, m, 5)).toISOString().slice(0, 10);
  const token = 'vati_FAKE' + y + String(m).padStart(2, '0');
  return {
    token, invoiceNumber: `${SUFFIX}-${month}`, description: `Tax Invoice for ${MONTHS[m - 1]} ${y}`, title: 'Tax Invoice',
    documentCategory: 'Tax Invoice', type: 'vat_invoice', invoiceType: 'common', invoiceLegalEntity: 'ES',
    createdString: issued, created: Date.parse(issued + 'T06:00:00Z') / 1000, generated_at: Date.parse(issued + 'T06:00:00Z') / 1000,
    periodStartInclusive: start, periodEndExclusive: end, reverseCharge, corrected: false, credited: null,
    downloadLinkAvailable: true, link: '/download/tax/vat/' + token, livemode: true, version: 1, hidden: false,
    regenerationDetails: { vatId: FAKE_STRIPE_TAX_ID, tds: null, italy_regenerate: null },
  };
}
const initial = () => [invoice('2026-04'), invoice('2026-05'), invoice('2026-09', { reverseCharge: true })];

const SPA = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fake Stripe Dashboard</title></head>
<body><h1>Fake Stripe Dashboard</h1><p id="t">loading</p><script>
var H={authorization:${JSON.stringify(KEY)},'stripe-account':${JSON.stringify(FAKE_STRIPE_ACCOUNT)},'stripe-livemode':'true'};
function go(){return fetch('/v1/accounts/${FAKE_STRIPE_ACCOUNT}',{headers:H}).then(function(){return fetch('/v1/settings/plans_and_fees/invoice_history_documents',{headers:H})})
  .then(function(r){return r.json()}).then(function(d){document.getElementById('t').textContent='loaded '+d.data.length;}).catch(function(){});}
go(); var n=0; var iv=setInterval(function(){ if(++n>8){clearInterval(iv);return;} go(); },500);
</script></body></html>`;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export function startMockStripe({ port = 0 } = {}) {
  let invoices = initial();
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const p = u.pathname;
      const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      try {
        if (p === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(SPA); }
        if (p === '/__control/reset' && req.method === 'POST') { invoices = initial(); return json({ ok: true }); }
        if (p === '/__control/invoice' && req.method === 'POST') { const b = await readJson(req); invoices.push(invoice(b.month, b)); return json({ ok: true }); }
        if (p === '/__control/state') return json({ invoices: invoices.length });
        // The stored PDF the download link redirects to (stands in for the signed S3 URL).
        if (p.startsWith('/__s3/')) { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(PDF); }
        // The download link: like the real one, the dashboard session cookie is not checked here, only the
        // document must exist.
        const dl = p.match(/^\/download\/tax\/vat\/([^/]+)$/);
        if (dl) {
          if (!invoices.some((i) => i.token === dl[1])) { res.writeHead(404); return res.end(); }
          res.writeHead(302, { location: '/__s3/vat/' + dl[1] + '.pdf' }); return res.end();
        }
        // The API wants exactly what the real one wants: the session key, the account and the livemode flag.
        if (!/^Bearer uk_/.test(req.headers.authorization || '')) return json({ error: { message: 'no session' } }, 401);
        if (!req.headers['stripe-livemode']) return json({ error: { message: 'When using session-based authentication, the Stripe-Livemode header is required.' } }, 400);
        if (req.headers['stripe-account'] !== FAKE_STRIPE_ACCOUNT) return json({ error: { message: 'unknown account' } }, 403);
        if (p === '/v1/accounts/' + FAKE_STRIPE_ACCOUNT) return json({ id: FAKE_STRIPE_ACCOUNT, object: 'account', country: 'ES', settings: { dashboard: { display_name: FAKE_STRIPE_ACCOUNT_NAME } }, business_profile: { name: FAKE_STRIPE_ACCOUNT_NAME } });
        if (p === '/v1/settings/plans_and_fees/invoice_history_documents') {
          if ([...u.searchParams.keys()].some((k) => k !== 'include_only[]')) return json({ error: { code: 'parameter_unknown' } }, 400);
          const data = invoices.slice().sort((a, b) => b.created - a.created);
          return json({ data, has_more: false, total_count: data.length, url: '/v1/settings/plans_and_fees/invoice_history_documents' });
        }
        res.writeHead(404); res.end();
      } catch (e) {
        json({ error: String(e.message || e) }, 400);
      }
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, origin: `http://localhost:${server.address().port}` }));
  });
}

// The fake dashboard's source: the published stripe-fees definition, pointed at loopback. Kept in step with
// sources-repo/sources/stripe-fees.json by stripe-fees.test.mjs.
export function fakeStripeSource(port, published) {
  const src = {
    ...published,
    id: 'fakestripe-e2e',
    name: 'Fake Stripe fees (E2E)',
    trust: 'community',
    domain: 'localhost',
    match: ['http://localhost/*'],
    openUrl: `http://localhost:${port}/`,
    auth: { ...published.auth, loginUrl: `http://localhost:${port}/` },
    api: { ...published.api, host: `http://localhost:${port}` },
  };
  delete src.crossDomainHosts; // loopback: the PDF redirect stays on the same host
  return src;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { origin } = await startMockStripe({ port: Number(process.argv[2]) || 0 });
  console.log(`Fake Stripe dashboard at ${origin}`);
}
