// Real end-to-end of RECORD MODE (the non-technical authoring flow) in a headless browser against
// the mock service: the in-session hook captures response samples, the author UI auto-drafts a
// source, shows a plain-language mapper, tests it live, and saves it. Only the permission prompt +
// dynamic content-script registration are bypassed (baked into the test manifest + learn flag);
// everything else — capture, inference, mapper, test, save — is the shipped code.
import { chromium } from 'playwright';
import { startMockService } from './mock-service.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = '/home/davefx/proyectos/habeas/extension';
const results = [];
const check = (n, c, d = '') => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

function buildTestExtension() {
  const dir = mkdtempSync(join(tmpdir(), 'habeas-author-'));
  cpSync(SRC, dir, { recursive: true });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  m.host_permissions.push('http://localhost/*');
  m.content_scripts.push({ matches: ['http://localhost/*'], js: ['src/content/bridge.js'], run_at: 'document_start' });
  m.web_accessible_resources.push({ resources: ['src/content/hook.js'], matches: ['http://localhost/*'] });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}

const { server, port } = await startMockService();
const extDir = buildTestExtension();
const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-sandbox'],
});

try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const id = sw.url().split('/')[2];

  // Arm learn mode for localhost (what "Grant access & open site" does), then let the hook capture.
  const seed = await ctx.newPage();
  await seed.goto(`chrome-extension://${id}/src/ui/options.html`);
  await seed.evaluate(async (origin) => {
    const c = globalThis.browser ?? globalThis.chrome;
    await c.storage.local.set({ 'habeas:learn': { active: true, domain: 'localhost', origin } });
  }, `http://localhost:${port}/*`);

  const site = await ctx.newPage();
  await site.goto(`http://localhost:${port}/`);
  await site.waitForFunction(() => document.getElementById('t')?.textContent.startsWith('loaded'), { timeout: 10000 });

  // Wait until the hook's learn-mode capture lands a sample.
  let samples = 0;
  for (let i = 0; i < 40 && !samples; i++) {
    samples = await seed.evaluate(async () => {
      const c = globalThis.browser ?? globalThis.chrome;
      const o = await c.storage.session.get('samples:localhost');
      return (o['samples:localhost'] || []).length;
    });
    if (!samples) await seed.waitForTimeout(250);
  }
  check('learn-mode hook captured response samples', samples > 0, `${samples} sample(s)`);

  // Drive the author UI.
  const author = await ctx.newPage();
  await author.goto(`chrome-extension://${id}/src/ui/author.html`);
  await author.waitForTimeout(400);
  await author.click('#analyze');
  await author.waitForSelector('#fieldmap .maprow', { timeout: 8000 }).catch(() => {});
  const rows = await author.locator('#fieldmap .maprow').count();
  check('auto-draft produced a field mapping', rows > 0, `${rows} fields`);

  // Non-technical: labels are plain language (no raw jargon), and the technical block is collapsed.
  const labels = await author.locator('#fieldmap .maprow label').allTextContents();
  const noJargon = !labels.some((l) => /externalId|itemsPath|storeName/.test(l));
  check('field labels are plain language (no jargon)', noJargon, labels.join(' | '));
  const advancedCollapsed = await author.locator('#mapper details').evaluate((e) => !e.open).catch(() => false);
  check('technical fields hidden under collapsed Advanced', advancedCollapsed);
  const hasExamples = (await author.locator('#fieldmap option').allTextContents()).some((o) => o.includes(' — '));
  check('dropdowns show real example values', hasExamples);

  // Test against the live mock API using the captured session.
  await author.click('#test');
  await author.waitForFunction(() => document.querySelectorAll('#preview tbody tr').length > 0, { timeout: 10000 }).catch(() => {});
  const preview = await author.locator('#preview tbody tr').count();
  check('Test lists real documents from the drafted source', preview === 3, `${preview}/3 rows`);

  // Save and confirm it was stored as a local source.
  await author.click('#save');
  await author.waitForTimeout(500);
  const stored = await seed.evaluate(async () => {
    const c = globalThis.browser ?? globalThis.chrome;
    const o = await c.storage.local.get('habeas:sources');
    return (o['habeas:sources'] || []).map((a) => a.id);
  });
  check('source saved locally', stored.includes('localhost'), stored.join(','));
} finally {
  await ctx.close();
  server.close();
  rmSync(extDir, { recursive: true, force: true });
}

console.log(`\nauthor-flow: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
