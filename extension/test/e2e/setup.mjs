// Shared setup for the e2e suites that drive the extension's own UI (e2e, author-flow, author-flow-complex,
// mixed-auth): launch Chromium with a test copy of the extension, then put it in the state the UI would after
// the user clicked through — a source enabled with its capture scripts registered and its consent given, or
// record mode armed for a site. Only the permission prompts are skipped (the test manifest already holds
// http://localhost); every script that runs afterwards is the shipped code.
//
// The capture scripts are registered at runtime (lib/capture.js, lib/learn.js), as the extension does for
// any enabled source, so a test must register them too: injecting bridge.js from the manifest no longer
// loads the page hook, which runs in the MAIN world.
import { chromium } from 'playwright';
import { rmSync } from 'node:fs';
import { buildTestExtension } from './harness.mjs';

export async function launchExtension() {
  const extDir = buildTestExtension();
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-sandbox'],
  });
  // Poll rather than only wait for the event: the worker may have started before we listen.
  let sw = context.serviceWorkers()[0];
  for (let i = 0; !sw && i < 60; i++) {
    sw = await context.waitForEvent('serviceworker', { timeout: 500 }).catch(() => context.serviceWorkers()[0]);
  }
  if (!sw) { await context.close().catch(() => {}); rmSync(extDir, { recursive: true, force: true }); throw new Error('extension service worker never started'); }
  const id = sw.url().split('/')[2];
  const page = await context.newPage(); // an extension page: the only place its storage and modules are reachable
  await page.goto(`chrome-extension://${id}/src/ui/options.html`);
  const close = async () => { await context.close().catch(() => {}); rmSync(extDir, { recursive: true, force: true }); };
  return { context, id, page, close };
}

export const getStore = (page, area, key) => page.evaluate(async ([a, k]) => (await (globalThis.browser ?? globalThis.chrome).storage[a].get(k))[k], [area, key]);

// Poll an extension storage key until `ok(value)` holds (or ~10 s pass); returns the last value read.
export async function waitStore(page, area, key, ok = (v) => v != null, tries = 40) {
  let v;
  for (let i = 0; i < tries; i++) {
    v = await getStore(page, area, key);
    if (ok(v)) return v;
    await page.waitForTimeout(250);
  }
  return v;
}

// Install + enable a source with a download sink, register its capture scripts and give the consent a
// community source needs before it may run (what Settings → Sources does on enable).
export async function enableSource(page, adapter) {
  await page.evaluate(async (src) => {
    const c = globalThis.browser ?? globalThis.chrome;
    await c.storage.local.set({
      'habeas:config': { version: 1, datasources: [{ id: src.id, adapter: src.id, enabled: true, options: {} }], sinks: [{ id: 'dl', type: 'download' }], routes: [] },
      'habeas:sources': [src],
    });
    const { registerCapture } = await import(c.runtime.getURL('src/lib/capture.js'));
    await registerCapture(src);
    const { grantConsent } = await import(c.runtime.getURL('src/lib/consent.js'));
    await grantConsent(src);
  }, adapter);
}

// Enable a source that is ALREADY stored (one just saved from record mode) with a download sink + consent.
export async function enableStoredSource(page, sourceId) {
  await page.evaluate(async (sid) => {
    const c = globalThis.browser ?? globalThis.chrome;
    const cfg = (await c.storage.local.get('habeas:config'))['habeas:config'] || { version: 1, datasources: [], sinks: [], routes: [] };
    cfg.datasources = [{ id: sid, adapter: sid, enabled: true, options: {} }];
    cfg.sinks = [{ id: 'dl', type: 'download' }];
    await c.storage.local.set({ 'habeas:config': cfg });
    const src = ((await c.storage.local.get('habeas:sources'))['habeas:sources'] || []).find((a) => a.id === sid);
    const { grantConsent } = await import(c.runtime.getURL('src/lib/consent.js'));
    if (src) await grantConsent(src);
  }, sourceId);
}

// Arm record mode for http://localhost:<port> — startLearning() minus its permission prompt and new tab.
export async function armLearning(page, port) {
  await page.evaluate(async (p) => {
    const c = globalThis.browser ?? globalThis.chrome;
    const matches = ['http://localhost/*'];
    const specs = [
      { id: 'habeas-learn-localhost-hook', matches, js: ['src/content/hook.js'], runAt: 'document_start', world: 'MAIN' },
      { id: 'habeas-learn-localhost', matches, js: ['src/content/bridge.js'], runAt: 'document_start' },
    ];
    for (const s of specs) { try { await c.scripting.registerContentScripts([s]); } catch (e) { await c.scripting.updateContentScripts([s]); } }
    await c.storage.local.set({ 'habeas:learn': { active: true, domain: 'localhost', origin: `http://localhost:${p}/*`, url: `http://localhost:${p}/` } });
  }, port);
}

// The listing + sending UI (formerly the popup, now the Advanced tools tab): pick the source, list, and
// wait for `count` rows. Returns the page.
export async function listInAdvanced(context, id, sourceId, count) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/src/ui/advanced.html`);
  await page.waitForSelector(`#ds option[value="${sourceId}"]`, { state: 'attached', timeout: 10000 }).catch(() => {});
  await page.selectOption('#ds', sourceId).catch(() => {});
  await page.click('#list');
  await page.waitForFunction((n) => document.querySelectorAll('#tbl tbody tr').length === n, count, { timeout: 15000 }).catch(() => {});
  return page;
}

// Send what's listed to the 'dl' download sink; resolves to the download (or null) and the status text.
export async function sendToDownload(context, page) {
  const dl = context.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.selectOption('#sink', 'dl').catch(() => {});
  await page.click('#send');
  const download = await dl;
  // The ZIP is saved before the send finishes (ledger, store, final status); it ends when #send is enabled again.
  await page.waitForFunction(() => !document.getElementById('send').disabled, null, { timeout: 15000 }).catch(() => {});
  return { download, status: (await page.locator('#status').textContent()) || '' };
}

// Did the send write all `n` documents WITH their files? The status reads "Sent to «dl»: <written> documents +
// manifest (<total> records)", plus a "· no file for N" suffix (n_nodoc) when some had none.
export function allFilesSent(status, n) {
  const m = String(status).match(/:\s*(\d+)\D+\((\d+)/);
  return !!m && Number(m[1]) === n && Number(m[2]) === n && !/·/.test(status);
}

// Names of the entries in a downloaded ZIP (local file headers: "PK\x03\x04", name length at +26, extra at +28).
export async function zipNames(download) {
  const { readFileSync } = await import('node:fs');
  const p = download && await download.path().catch(() => null);
  if (!p) return [];
  const b = readFileSync(p), names = [];
  for (let i = 0; i + 30 <= b.length;) {
    if (b.readUInt32LE(i) !== 0x04034b50) break;
    const size = b.readUInt32LE(i + 18), n = b.readUInt16LE(i + 26), x = b.readUInt16LE(i + 28);
    names.push(b.toString('utf8', i + 30, i + 30 + n));
    i += 30 + n + x + size;
  }
  return names;
}
