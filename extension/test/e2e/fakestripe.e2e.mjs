// The Stripe fee-invoice source end to end, through the external-hooks bridge: Habeas captures the fake
// dashboard's opaque `uk_` session key, a minimal app on localhost proposes a workflow from it to its own http
// endpoint, and after collect the endpoint must receive every fee invoice as an invoice@2 received record WITH
// its PDF. The path Cuéntamo's received-invoices inbox takes; its suite can start from
// launchHabeasWithFakeBank({ stripe: true }).
import http from 'node:http';
import { launchHabeasWithFakeBank } from './harness.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

// The app: a blank page (the bridge runs on http://localhost) and an ingest endpoint that keeps what arrives.
function startApp() {
  const received = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><html><body>app</body></html>'); }
      if (req.method === 'POST' && req.url === '/ingest') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          const form = await new Request('http://x/', { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }).formData();
          received.push({ source: form.get('source'), auth: req.headers.authorization, records: JSON.parse(form.get('records') || '[]'), files: form.getAll('files[]').map((f) => f.name) });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, received, origin: `http://localhost:${server.address().port}` }));
  });
}

// Call the bridge from the app's page, exactly as an app would.
const bridge = (page, api, payload) => page.evaluate(([a, p]) => new Promise((resolve) => {
  const id = 'e2e' + Math.random().toString(36).slice(2);
  const on = (ev) => { const d = ev.data; if (ev.source === window && d && d.__habeasExt === 'res' && d.id === id) { window.removeEventListener('message', on); resolve(d.response ?? null); } };
  window.addEventListener('message', on);
  window.postMessage({ __habeasExt: 'req', id, api: a, payload: p }, location.origin);
  setTimeout(() => resolve(null), 30000);
}), [api, payload]);

const app = await startApp();
const h = await launchHabeasWithFakeBank({ stripe: true });
try {
  check('fake Stripe dashboard seeded and its uk_ session captured', !!h.stripe, h.stripe && h.stripe.origin);
  const expected = (await (await fetch(`${h.stripe.origin}/__control/state`)).json()).invoices;
  const src = h.stripe.source.id;

  const page = await h.context.newPage();
  await page.goto(`${app.origin}/`);
  const proposed = bridge(page, 'propose-workflow', { source: src, sink: { type: 'http', url: `${app.origin}/ingest`, name: 'E2E app', headers: { Authorization: 'Bearer e2e-pairing' } } });
  await h.approveConsent();
  const proposal = await proposed;
  check('propose-workflow answered after consent', proposal && proposal.ok !== false, JSON.stringify(proposal));

  let grantId = null;
  for (let i = 0; i < 40 && !grantId; i++) {
    const st = await bridge(page, 'status');
    grantId = st && (st.grants || []).find((g) => g.source === src)?.grantId;
    if (!grantId) await page.waitForTimeout(250);
  }
  check('status lists the grant for the Stripe source', !!grantId, grantId || 'none');
  const collected = await bridge(page, 'collect', { grantId });
  check('collect starts', collected && collected.ok !== false, JSON.stringify(collected));

  const records = () => app.received.flatMap((r) => r.records);
  for (let i = 0; i < 120 && records().length < expected; i++) await page.waitForTimeout(500);
  const recs = records();
  check('the app receives every fee invoice', recs.length === expected, `${recs.length}/${expected}`);
  check('each record is an invoice@2 received invoice', recs.length > 0 && recs.every((r) => r._schema === 'invoice@2' && r.flow === 'received'));
  const sep = recs.find((r) => /-2026-09$/.test(r.number || ''));
  check('number, issue date, inclusive billed period and reverse charge come through',
    sep && sep.issueDate === '2026-10-05' && sep.servicePeriod && sep.servicePeriod.start === '2026-09-01' && sep.servicePeriod.end === '2026-09-30' && sep.reverseCharge === true,
    JSON.stringify(sep && { number: sep.number, issueDate: sep.issueDate, servicePeriod: sep.servicePeriod, reverseCharge: sep.reverseCharge }));
  check('each record names the account it came from', recs.length > 0 && recs.every((r) => r.account && /^acct_/.test(r.account.id) && r.account.label), JSON.stringify(recs[0] && recs[0].account));
  check('no amounts are invented (the list has none)', recs.every((r) => !('total' in r) && !('currency' in r) && !('taxes' in r)));
  const files = app.received.flatMap((r) => r.files);
  check('every invoice arrives with its PDF, named after its internalId', recs.length > 0 && recs.every((r) => r.pdf === true && files.includes(r.internalId + '.pdf')), files.join(', '));
  check('the delivery names the source', app.received.length > 0 && app.received.every((r) => r.source === src), [...new Set(app.received.map((r) => r.source))].join(', '));
  if (recs.length < expected) {
    const dbg = await h.context.newPage();
    await dbg.goto(`chrome-extension://${h.extensionId}/src/ui/options.html`);
    const log = await dbg.evaluate(async () => { const c = globalThis.browser ?? globalThis.chrome; return (await c.storage.local.get('habeas:log'))['habeas:log']; });
    console.log('habeas:log', JSON.stringify((log || []).slice(-8), null, 1));
  }
} finally {
  await h.close();
  app.server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nE2E (fake Stripe): ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
