// e2e: MIXED auth — the list is authed by a session cookie, the PDF by a bearer JWT. Records both,
// infers cookie mode for the source, and at run time fetches the list with cookies and the PDF with
// the captured bearer (per-endpoint auth resolution).
import { chromium } from 'playwright';
import { startMockMixed } from './mock-mixed.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = '/home/user/proyectos/habeas/extension';
const results = [];
const check = (n, c, d = '') => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

function buildTestExtension() {
  const dir = mkdtempSync(join(tmpdir(), 'habeas-mx-'));
  cpSync(SRC, dir, { recursive: true });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  m.host_permissions.push('http://localhost/*');
  m.content_scripts.push({ matches: ['http://localhost/*'], js: ['src/content/bridge.js'], run_at: 'document_start' });
  m.web_accessible_resources.push({ resources: ['src/content/hook.js'], matches: ['http://localhost/*'] });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}

const { server, port, orders } = await startMockMixed();
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

  const site = await ctx.newPage();
  await site.goto(`http://localhost:${port}/`);
  await site.waitForFunction(() => document.getElementById('t')?.textContent === 'loaded', { timeout: 10000 });
  let samples = [];
  for (let i = 0; i < 40 && !samples.length; i++) { samples = (await getStore(seed, 'session', 'samples:localhost')) || []; if (!samples.length) await seed.waitForTimeout(250); }
  check('cookie-authed list captured', samples.length >= 1, `${samples.length} samples`);

  await site.goto(`http://localhost:${port}/orders/ORD-2`);
  await site.waitForFunction(() => /pdf 200/.test(document.getElementById('t')?.textContent || ''), { timeout: 10000 }).catch(() => {});
  let assets = [];
  for (let i = 0; i < 40 && !assets.length; i++) { assets = (await getStore(seed, 'session', 'assets:localhost')) || []; if (!assets.length) await seed.waitForTimeout(250); }
  check('bearer-authed PDF captured', assets.some((a) => /\/pdf$/.test(a.url)));

  const author = await ctx.newPage();
  await author.goto(`chrome-extension://${id}/src/ui/author.html`);
  await author.waitForTimeout(400);
  await author.click('#analyze');
  await author.waitForSelector('#fieldmap .maprow', { timeout: 8000 }).catch(() => {});
  await author.click('#test');
  await author.waitForFunction((n) => document.querySelectorAll('#preview tbody tr').length === n, orders, { timeout: 10000 }).catch(() => {});
  check('Test lists via cookies (no bearer leaked to the list)', (await author.locator('#preview tbody tr').count()) === orders);
  await author.click('#save');
  await author.waitForTimeout(500);
  const saved = ((await getStore(seed, 'local', 'habeas:sources')) || []).find((a) => a.id === 'localhost');
  check('source inferred as cookie auth', saved && saved.auth && saved.auth.mode === 'cookie', saved && JSON.stringify(saved.auth));

  // Run it: list via cookies, PDF via the captured bearer.
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
  check('run: list fetched via cookies', (await popup.locator('#tbl tbody tr').count()) === orders);
  const dl = ctx.waitForEvent('download', { timeout: 10000 }).catch(() => null);
  await popup.selectOption('#sink', 'dl').catch(() => {});
  await popup.click('#send');
  const download = await dl;
  await popup.waitForTimeout(300);
  const sent = (await popup.locator('#status').textContent()) || '';
  check('run: PDF fetched via the bearer JWT', !!download && /0 (sin PDF|without PDF)/.test(sent), sent);
} finally {
  await ctx.close();
  server.close();
  rmSync(extDir, { recursive: true, force: true });
}

console.log(`\nmixed-auth: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
