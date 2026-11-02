// e2e: MIXED auth — the list is authed by a session cookie, the PDF by a bearer JWT. Records both,
// infers cookie mode for the source, and at run time fetches the list with cookies and the PDF with
// the captured bearer (per-endpoint auth resolution).
import { startMockMixed } from './mock-mixed.mjs';
import { launchExtension, armLearning, getStore, enableStoredSource, listInAdvanced, sendToDownload, allFilesSent, zipNames } from './setup.mjs';

const results = [];
const check = (n, c, d = '') => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const { server, port, orders } = await startMockMixed();
const { context: ctx, id, page: seed, close } = await launchExtension();

try {
  await armLearning(seed, port);

  const site = await ctx.newPage();
  await site.goto(`http://localhost:${port}/`);
  await site.waitForFunction(() => document.getElementById('t')?.textContent === 'loaded', null, { timeout: 10000 });
  let samples = [];
  for (let i = 0; i < 40 && !samples.length; i++) { samples = (await getStore(seed, 'session', 'samples:localhost')) || []; if (!samples.length) await seed.waitForTimeout(250); }
  check('cookie-authed list captured', samples.length >= 1, `${samples.length} samples`);

  await site.goto(`http://localhost:${port}/orders/ORD-2`);
  await site.waitForFunction(() => /pdf 200/.test(document.getElementById('t')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  let assets = [];
  for (let i = 0; i < 40 && !assets.length; i++) { assets = (await getStore(seed, 'session', 'assets:localhost')) || []; if (!assets.length) await seed.waitForTimeout(250); }
  check('bearer-authed PDF captured', assets.some((a) => /\/pdf$/.test(a.url)));

  const author = await ctx.newPage();
  await author.goto(`chrome-extension://${id}/src/ui/author.html`);
  await author.waitForTimeout(400);
  await author.click('#stop'); // stopping the recording analyses it straight away
  await author.waitForSelector('#fieldmap .maprow', { timeout: 8000 }).catch(() => {});
  await author.click('#test');
  await author.waitForFunction((n) => document.querySelectorAll('#preview tbody tr').length === n, orders, { timeout: 10000 }).catch(() => {});
  check('Test lists via cookies (no bearer leaked to the list)', (await author.locator('#preview tbody tr').count()) === orders);
  await author.click('#save');
  await author.waitForTimeout(500);
  const saved = ((await getStore(seed, 'local', 'habeas:sources')) || []).find((a) => a.id === 'localhost');
  check('source inferred as cookie auth', saved && saved.auth && saved.auth.mode === 'cookie', saved && JSON.stringify(saved.auth));

  // Run it: list via cookies, PDF via the captured bearer.
  await enableStoredSource(seed, 'localhost');
  const popup = await listInAdvanced(ctx, id, 'localhost', orders);
  check('run: list fetched via cookies', (await popup.locator('#tbl tbody tr').count()) === orders);
  const { download, status: sent } = await sendToDownload(ctx, popup);
  const pdfs = (await zipNames(download)).filter((n) => /\.pdf$/i.test(n));
  check('run: PDF fetched via the bearer JWT', !!download && allFilesSent(sent, orders) && pdfs.length === orders, `${sent} · ${pdfs.length} PDF in the ZIP`);
} finally {
  await close();
  server.close();
}

console.log(`\nmixed-auth: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
