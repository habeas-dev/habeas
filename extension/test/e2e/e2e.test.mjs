// Real end-to-end: load the actual extension in a headless (xvfb) Chromium against a controlled
// fake service, and drive the real code path — in-session auth capture → inventory (paginated
// fetch with replayed headers) → popup render → send to the download sink. This exercises the
// content hook, background, loader+validator, runtime and UI exactly as shipped; only the service
// is faked (I can't reproduce a user's real authenticated session, which is the whole product).
import { chromium } from 'playwright';
import { startMockService } from './mock-service.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC_EXT = '/home/user/proyectos/habeas/extension';
const results = [];
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

function buildTestExtension() {
  const dir = mkdtempSync(join(tmpdir(), 'habeas-ext-'));
  cpSync(SRC_EXT, dir, { recursive: true });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  m.host_permissions.push('http://localhost/*');
  m.content_scripts.push({ matches: ['http://localhost/*'], js: ['src/content/bridge.js'], run_at: 'document_start' });
  m.web_accessible_resources.push({ resources: ['src/content/hook.js'], matches: ['http://localhost/*'] });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}

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
      pdf: { path: '/api/pdf/{externalId}' },
    },
    fields: { externalId: 'id', date: 'date', total: 'total', storeName: 'shop', type: 'kind', source: 'channel' },
    schema: 'receipt@1',
  };
}

const { server, port, count } = await startMockService();
const extDir = buildTestExtension();
const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-sandbox'],
});

try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const id = sw.url().split('/')[2];
  check('extension loads (service worker)', !!id, id);

  // Seed a datasource + the mock source + a download sink into the real config store.
  const seed = await ctx.newPage();
  await seed.goto(`chrome-extension://${id}/src/ui/options.html`);
  await seed.evaluate(async (adapter) => {
    const c = globalThis.browser ?? globalThis.chrome;
    await c.storage.local.set({
      'habeas:config': { version: 1, datasources: [{ id: 'mock-localhost', adapter: 'mock-localhost', enabled: true, options: {} }], sinks: [{ id: 'dl', type: 'download' }], routes: [] },
      'habeas:sources': [adapter],
    });
  }, mockAdapter(port));
  await seed.reload();
  check('seeded mock source appears in catalog', (await seed.locator('#ds .card').count()) >= 2);

  // Visit the fake logged-in SPA → it calls its API with a JWT → the hook must capture it.
  const site = await ctx.newPage();
  await site.goto(`http://localhost:${port}/`);
  await site.waitForFunction(() => document.getElementById('t')?.textContent.startsWith('loaded'), { timeout: 10000 });

  const authKey = 'auth:localhost:' + port;
  let captured = null;
  for (let i = 0; i < 40 && !captured; i++) {
    captured = await seed.evaluate(async (k) => {
      const c = globalThis.browser ?? globalThis.chrome;
      const o = await c.storage.session.get(k);
      return o[k] || null;
    }, authKey);
    if (!captured) await seed.waitForTimeout(250);
  }
  check('in-session auth captured by hook', captured && /eyJ/.test((captured.merged || {}).authorization || ''), captured ? 'headers: ' + Object.keys(captured.merged).join(',') : 'none');

  // Drive the popup: list documents from the mock API using the captured session.
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/src/ui/popup.html`);
  await popup.waitForTimeout(400);
  await popup.selectOption('#ds', 'mock-localhost').catch(() => {});
  await popup.click('#list');
  await popup.waitForFunction((n) => document.querySelectorAll('#tbl tbody tr').length === n, count, { timeout: 10000 }).catch(() => {});
  const rows = await popup.locator('#tbl tbody tr').count();
  check('popup lists all documents via replayed auth', rows === count, `${rows}/${count} rows`);

  const firstStore = await popup.locator('#tbl tbody tr').first().locator('td').nth(3).textContent();
  check('rendered document shows mapped store field', /Mock/.test(firstStore || ''), firstStore || '');

  // Send to the download sink → expect a browser download of the ZIP.
  let downloaded = null;
  const dlPromise = ctx.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await popup.selectOption('#sink', 'dl').catch(() => {});
  await popup.click('#send');
  downloaded = await dlPromise;
  check('send to download sink produces a ZIP', downloaded && /habeas-.*\.zip/.test(downloaded.suggestedFilename() || ''), downloaded ? downloaded.suggestedFilename() : 'no download event');
} finally {
  await ctx.close();
  server.close();
  rmSync(extDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\nE2E: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
