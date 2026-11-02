// Harder record-mode e2e in a real browser: several captured lists → search by a value that
// appears in TWO lists (disambiguation) → pick the orders list → a PDF gated behind its detail
// page via the Referer header → save → use the source (popup) to download the Referer-gated PDF.
import { startMockComplex } from './mock-complex.mjs';
import { launchExtension, armLearning, getStore, waitStore, enableStoredSource, listInAdvanced, sendToDownload, allFilesSent, zipNames } from './setup.mjs';

const results = [];
const check = (n, c, d = '') => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const { server, port, orders } = await startMockComplex();
const { context: ctx, id, page: seed, close } = await launchExtension();

try {
  await armLearning(seed, port);

  const site = await ctx.newPage();
  await site.goto(`http://localhost:${port}/`);
  await site.waitForFunction(() => document.getElementById('t')?.textContent === 'loaded', null, { timeout: 10000 });
  let samples = [];
  for (let i = 0; i < 40 && samples.length < 3; i++) {
    samples = (await getStore(seed, 'session', 'samples:localhost')) || [];
    if (samples.length < 3) await seed.waitForTimeout(250);
  }
  check('captured multiple lists', samples.length >= 3, `${samples.length} samples`);

  // Then navigate to an order's DETAIL page → the SPA fetches its PDF (Referer = the detail page).
  await site.goto(`http://localhost:${port}/orders/ORD-2`);
  await site.waitForFunction(() => /pdf 200/.test(document.getElementById('t')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  // Two reporters see the PDF request: the network observer (URL only) usually lands first, the page hook
  // (with the Referer page) a moment later — so wait for the Referer, not for the first entry.
  const withReferer = (arr) => (arr || []).some((a) => /\/pdf$/.test(a.url) && /\/orders\/ORD-2/.test(a.referer || ''));
  const assets = (await waitStore(seed, 'session', 'assets:localhost', withReferer)) || [];
  check('captured the Referer-gated PDF request', withReferer(assets), JSON.stringify(assets.map((a) => ({ url: a.url, referer: a.referer }))));

  // Author UI.
  const author = await ctx.newPage();
  await author.goto(`chrome-extension://${id}/src/ui/author.html`);
  await author.waitForTimeout(400);
  await author.click('#stop'); // stopping the recording analyses it straight away
  await author.waitForSelector('#f_list option', { timeout: 8000 }).catch(() => {});
  const listCount = await author.locator('#f_list option').count();
  check('several candidate lists offered', listCount >= 3, `${listCount} lists`);

  // Search an ambiguous value (SKU-9 is in orders AND wishlist).
  await author.locator('#adjust > summary').click(); // the search lives under "Adjust"
  await author.fill('#f_find', 'SKU-9');
  await author.click('#findbtn');
  await author.waitForTimeout(300);
  const findStatus = (await author.locator('#findstatus').textContent()) || '';
  check('search reports several possible lists', /2/.test(findStatus), findStatus);
  const pickerVisible = await author.locator('#listpickrow').isVisible();
  check('list picker revealed for disambiguation', pickerVisible);

  // Pick the orders list explicitly.
  const opts = await author.locator('#f_list option').allTextContents();
  // Options read "<n> items · <preview of the first item>"; the orders list is the only one with `orders` items.
  const ordersIdx = opts.findIndex((o) => o.startsWith(orders + ' '));
  await author.selectOption('#f_list', String(ordersIdx));
  await author.waitForTimeout(300);
  const docNote = (await author.locator('#status').textContent()) || '';
  check('orders list → saves a PDF per item', /PDF|pdf/i.test(docNote), docNote);

  // Test + Save.
  await author.click('#test');
  await author.waitForFunction((n) => document.querySelectorAll('#preview tbody tr').length === n, orders, { timeout: 10000 }).catch(() => {});
  check('Test lists the orders', (await author.locator('#preview tbody tr').count()) === orders);
  await author.click('#save');
  await author.waitForTimeout(500);
  const saved = ((await getStore(seed, 'local', 'habeas:sources')) || []).find((a) => a.id === 'localhost');
  check('saved source has a templated Referer-gated PDF', !!(saved && saved.api.pdf && /\{internalId\}/.test(saved.api.pdf.referer || '')), saved && JSON.stringify(saved.api.pdf));

  // Use the source: enable it + a download sink, then send → the runtime must fetch the PDF with the
  // Referer set via declarativeNetRequest (the mock 403s without it).
  await enableStoredSource(seed, 'localhost');
  const popup = await listInAdvanced(ctx, id, 'localhost', orders);
  const { download, status: sent } = await sendToDownload(ctx, popup);
  // Every order written with its file means the Referer-gated PDF was fetched (DNR worked); a 403 would add
  // a "no file for N" suffix.
  const pdfs = (await zipNames(download)).filter((n) => /\.pdf$/i.test(n));
  check('Referer-gated PDF fetched via declarativeNetRequest', !!download && allFilesSent(sent, orders) && pdfs.length === orders, `${sent} · ${pdfs.length} PDF in the ZIP`);
} finally {
  await close();
  server.close();
}

console.log(`\nauthor-flow-complex: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);

