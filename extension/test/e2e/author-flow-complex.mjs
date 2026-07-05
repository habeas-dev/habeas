// Harder record-mode e2e in a real browser: several captured lists → search by a value that
// appears in TWO lists (disambiguation) → pick the orders list → a PDF gated behind its detail
// page via the Referer header → save → use the source (popup) to download the Referer-gated PDF.
import { chromium } from 'playwright';
import { startMockComplex } from './mock-complex.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = '/home/user/proyectos/habeas/extension';
const results = [];
const check = (n, c, d = '') => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

function buildTestExtension() {
  const dir = mkdtempSync(join(tmpdir(), 'habeas-cx-'));
  cpSync(SRC, dir, { recursive: true });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  m.host_permissions.push('http://localhost/*');
  m.content_scripts.push({ matches: ['http://localhost/*'], js: ['src/content/bridge.js'], run_at: 'document_start' });
  m.web_accessible_resources.push({ resources: ['src/content/hook.js'], matches: ['http://localhost/*'] });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}

const { server, port, orders } = await startMockComplex();
const extDir = buildTestExtension();
const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-sandbox'],
});
const getStore = (page, area, key) => page.evaluate(async ([a, k]) => (await (globalThis.browser ?? globalThis.chrome).storage[a].get(k))[k], [area, key]);

try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const id = sw.url().split('/')[2];

  const seed = await ctx.newPage();
  await seed.goto(`chrome-extension://${id}/src/ui/options.html`);
  await seed.evaluate(async (o) => { await (globalThis.browser ?? globalThis.chrome).storage.local.set({ 'habeas:learn': { active: true, domain: 'localhost', origin: o } }); }, `http://localhost:${port}/*`);

  // Capture the three lists on the home page — WAIT until they're actually captured before leaving
  // (the hook arms slightly after the first fetch; navigating early would drop them).
  const site = await ctx.newPage();
  await site.goto(`http://localhost:${port}/`);
  await site.waitForFunction(() => document.getElementById('t')?.textContent === 'loaded', { timeout: 10000 });
  let samples = [];
  for (let i = 0; i < 40 && samples.length < 3; i++) {
    samples = (await getStore(seed, 'session', 'samples:localhost')) || [];
    if (samples.length < 3) await seed.waitForTimeout(250);
  }
  check('captured multiple lists', samples.length >= 3, `${samples.length} samples`);

  // Then navigate to an order's DETAIL page → the SPA fetches its PDF (Referer = the detail page).
  await site.goto(`http://localhost:${port}/orders/ORD-2`);
  await site.waitForFunction(() => /pdf 200/.test(document.getElementById('t')?.textContent || ''), { timeout: 10000 }).catch(() => {});
  let assets = [];
  for (let i = 0; i < 40 && !assets.length; i++) {
    assets = (await getStore(seed, 'session', 'assets:localhost')) || [];
    if (!assets.length) await seed.waitForTimeout(250);
  }
  check('captured the Referer-gated PDF request', assets.some((a) => /\/pdf$/.test(a.url) && /\/orders\/ORD-2/.test(a.referer || '')), JSON.stringify(assets.map((a) => a.url)));

  // Author UI.
  const author = await ctx.newPage();
  await author.goto(`chrome-extension://${id}/src/ui/author.html`);
  await author.waitForTimeout(400);
  await author.click('#analyze');
  await author.waitForSelector('#f_list option', { timeout: 8000 }).catch(() => {});
  const listCount = await author.locator('#f_list option').count();
  check('several candidate lists offered', listCount >= 3, `${listCount} lists`);

  // Search an ambiguous value (SKU-9 is in orders AND wishlist).
  await author.fill('#f_find', 'SKU-9');
  await author.click('#findbtn');
  await author.waitForTimeout(300);
  const findStatus = (await author.locator('#findstatus').textContent()) || '';
  check('search reports several possible lists', /2/.test(findStatus), findStatus);
  const pickerVisible = await author.locator('#listpickrow').isVisible();
  check('list picker revealed for disambiguation', pickerVisible);

  // Pick the orders list explicitly.
  const opts = await author.locator('#f_list option').allTextContents();
  const ordersIdx = opts.findIndex((o) => o.includes('/api/orders'));
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
  check('saved source has a templated Referer-gated PDF', !!(saved && saved.api.pdf && /\{externalId\}/.test(saved.api.pdf.referer || '')), saved && JSON.stringify(saved.api.pdf));

  // Use the source: enable it + a download sink, then send → the runtime must fetch the PDF with the
  // Referer set via declarativeNetRequest (the mock 403s without it).
  await seed.evaluate(async () => {
    const c = globalThis.browser ?? globalThis.chrome;
    const cfg = (await c.storage.local.get('habeas:config'))['habeas:config'] || { version: 1, datasources: [], sinks: [], routes: [] };
    cfg.datasources = [{ id: 'localhost', adapter: 'localhost', enabled: true, options: {} }];
    cfg.sinks = [{ id: 'dl', type: 'download' }];
    await c.storage.local.set({ 'habeas:config': cfg });
  });
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/src/ui/popup.html`);
  await popup.waitForTimeout(400);
  await popup.selectOption('#ds', 'localhost').catch(() => {});
  await popup.click('#list');
  await popup.waitForFunction((n) => document.querySelectorAll('#tbl tbody tr').length === n, orders, { timeout: 10000 }).catch(() => {});
  const dl = ctx.waitForEvent('download', { timeout: 10000 }).catch(() => null);
  await popup.selectOption('#sink', 'dl').catch(() => {});
  await popup.click('#send');
  const download = await dl;
  await popup.waitForTimeout(300);
  const sent = (await popup.locator('#status').textContent()) || '';
  // "0 without PDF" means every doc's Referer-gated PDF was fetched (DNR worked); 403 → "2 without".
  check('Referer-gated PDF fetched via declarativeNetRequest', !!download && /0 (sin PDF|without PDF)/.test(sent), sent);
} finally {
  await ctx.close();
  server.close();
  rmSync(extDir, { recursive: true, force: true });
}

console.log(`\nauthor-flow-complex: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
