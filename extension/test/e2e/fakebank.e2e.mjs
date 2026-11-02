// Smoke test of the harness, end to end through the external-hooks bridge: a minimal app on localhost
// proposes a workflow from the fake bank to its own http endpoint, the test approves the consent screen,
// the app asks Habeas to collect, and its endpoint must receive every movement and broker record. This is
// the path any app that consumes Habeas takes, so an app's own suite can build on launchHabeasWithFakeBank().
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
          received.push({ source: form.get('source'), auth: req.headers.authorization, records: JSON.parse(form.get('records') || '[]') });
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
const h = await launchHabeasWithFakeBank();
try {
  check('extension loaded, fake bank seeded and its session captured', !!h.extensionId, h.extensionId);
  const state = await (await fetch(`${h.bank.origin}/__control/state`)).json();
  const expected = Object.values(state.movements).reduce((a, b) => a + b, 0) + state.broker;

  const page = await h.context.newPage();
  await page.goto(`${app.origin}/`);
  const proposed = bridge(page, 'propose-workflow', { source: h.source.id, sink: { type: 'http', url: `${app.origin}/ingest`, name: 'E2E app', headers: { Authorization: 'Bearer e2e-pairing' } } });
  await h.approveConsent();
  const proposal = await proposed;
  check('propose-workflow answered after consent', proposal && proposal.ok !== false, JSON.stringify(proposal));

  let grantId = null;
  for (let i = 0; i < 40 && !grantId; i++) {
    const st = await bridge(page, 'status');
    grantId = st && (st.grants || []).find((g) => g.source === h.source.id)?.grantId;
    if (!grantId) await page.waitForTimeout(250);
  }
  check('status lists the grant for the fake bank', !!grantId, grantId || 'none');

  const collected = await bridge(page, 'collect', { grantId });
  check('collect starts', collected && collected.ok !== false, JSON.stringify(collected));
  const count = () => app.received.reduce((n, r) => n + r.records.length, 0);
  for (let i = 0; i < 120 && count() < expected; i++) await page.waitForTimeout(500);
  check('the app receives every movement and broker record', count() === expected, `${count()}/${expected}`);
  // `source` names the source AND the stream that produced the batch ("<id>:<stream>").
  const sources = new Set(app.received.map((r) => r.source));
  check('each delivery names its source and stream', sources.has(`${h.source.id}:movements`) && sources.has(`${h.source.id}:portfolio`) && sources.size === 2, [...sources].join(', '));
  check('each delivery carries the pairing header the app proposed', app.received.length > 0 && app.received.every((r) => r.auth === 'Bearer e2e-pairing'));
  if (count() < expected) {
    // On failure, show what Habeas itself logged about the run.
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
console.log(`\nE2E (fake bank): ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
