// Real end-to-end: load the actual extension in a headless (xvfb) Chromium against a controlled
// fake service, and drive the real code path — in-session auth capture → inventory (paginated
// fetch with replayed headers) → popup render → send to the download sink. This exercises the
// content hook, background, loader+validator, runtime and UI exactly as shipped; only the service
// is faked (I can't reproduce a user's real authenticated session, which is the whole product).
import { startMockService } from './mock-service.mjs';
import { launchExtension, enableSource, waitStore, listInAdvanced, sendToDownload, allFilesSent, zipNames } from './setup.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

function mockAdapter(port) {
  return {
    id: 'mock-localhost', name: 'Mock Local', service: 'mock', trust: 'first-party', domain: 'localhost',
    categories: ['grocery', 'fuel', 'retail'],
    categorize: { field: 'kind', map: { FOOD: 'grocery', FUEL: 'fuel' }, default: 'retail' },
    match: ['http://localhost/*'],
    auth: { tokenMatch: 'eyJ', replayHeaders: ['authorization', 'x-csrf-token'] },
    api: {
      host: 'http://localhost:' + port,
      list: { path: '/api/list', paging: 'offsets', itemsPath: 'receipts', offsetsPath: 'offsets', initialOffsets: { o: 0 }, params: { count: 50 } },
      pdf: { path: '/api/pdf/{internalId}' },
    },
    fields: { internalId: 'id', date: 'date', total: 'total', storeName: 'shop', type: 'kind', source: 'channel' },
    schema: 'receipt@1',
  };
}

const { server, port, count } = await startMockService();
const { context: ctx, id, page: seed, close } = await launchExtension();

try {
  check('extension loads (service worker)', !!id, id);

  // Enable the mock source (installed, capture registered, consent given) with a download sink.
  await enableSource(seed, mockAdapter(port));
  await seed.reload();
  check('seeded mock source appears in catalog', await seed.locator('#ds .src-card[data-hay*="mock-localhost"]').count() === 1);

  // Visit the fake logged-in SPA → it calls its API with a JWT → the hook must capture it.
  const site = await ctx.newPage();
  await site.goto(`http://localhost:${port}/`);
  await site.waitForFunction(() => document.getElementById('t')?.textContent.startsWith('loaded'), null, { timeout: 10000 });
  const captured = await waitStore(seed, 'session', 'auth:localhost:' + port);
  check('in-session auth captured by hook', captured && /eyJ/.test((captured.merged || {}).authorization || ''), captured ? 'headers: ' + Object.keys(captured.merged).join(',') : 'none');

  // List documents from the mock API using the captured session, in the Advanced tools tab.
  const popup = await listInAdvanced(ctx, id, 'mock-localhost', count);
  const rows = await popup.locator('#tbl tbody tr').count();
  check('lists all documents via replayed auth', rows === count, `${rows}/${count} rows`);

  const shown = (await popup.locator('#tbl tbody').textContent()) || '';
  check('rendered documents show the mapped store field', /Mock/.test(shown), shown.replace(/\s+/g, ' ').slice(0, 80));

  // Send to the download sink → expect a browser download of the ZIP.
  const { download, status } = await sendToDownload(ctx, popup);
  check('send to download sink produces a ZIP', download && /habeas-.*\.zip/.test(download.suggestedFilename() || ''), download ? download.suggestedFilename() : 'no download event');
  const pdfs = (await zipNames(download)).filter((n) => /\.pdf$/i.test(n));
  // The send must also FINISH: the ZIP is saved before the ledger/store/status step, which once threw after it.
  check('send completes with every document and its PDF', allFilesSent(status, count) && pdfs.length === count, `${status} · ${pdfs.length} PDF in the ZIP`);
} finally {
  await close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nE2E: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
