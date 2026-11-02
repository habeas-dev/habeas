// Reusable end-to-end harness for apps that consume Habeas: the real, shipped extension in a
// Chromium under Playwright, with the fake bank (mock-bank.mjs) seeded as an installed source and its
// session already captured — the state a user is in after installing Habeas and logging into their bank.
// From there a consumer's own page drives the bridge (ping / propose-workflow / collect) for real, and the
// test approves the consent screen like a user would.
//
// TEST ONLY: the extension is copied to a temp dir and its manifest patched to hold the host permission for
// http://localhost (the fake bank), which a user grants when enabling a source. The shipped manifest is never
// touched.
//
//   import { launchHabeasWithFakeBank } from '<habeas>/extension/test/e2e/harness.mjs';
//   const h = await launchHabeasWithFakeBank();
//   const page = await h.context.newPage();            // the consumer's page, in the same browser
//   …  await h.approveConsent();                         // when the consumer proposes a workflow
//   await h.close();
import { chromium } from 'playwright';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockBank, fakeBankSource } from './mock-bank.mjs';

const SRC_EXT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

// Copy of the extension with the host permission for loopback http, where the fake bank lives. The capture
// scripts are registered at runtime (lib/capture.js), as for any enabled source; the external-hooks bridge
// already runs on http://localhost (an app in local dev).
export function buildTestExtension() {
  const dir = mkdtempSync(join(tmpdir(), 'habeas-ext-'));
  cpSync(SRC_EXT, dir, { recursive: true, filter: (p) => !p.includes(`${SRC_EXT}/test`) });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  m.host_permissions.push('http://localhost/*');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}

async function extensionId(context) {
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  return sw.url().split('/')[2];
}

// Read a storage area from inside an extension page (the only place the extension's storage is reachable).
async function readStorage(page, area, key) {
  return page.evaluate(async ([a, k]) => {
    const c = globalThis.browser ?? globalThis.chrome;
    const o = await c.storage[a].get(k);
    return o[k] ?? null;
  }, [area, key]);
}

/**
 * Launch Chromium with Habeas, the fake bank running and seeded as an installed source, and its session
 * captured. Options:
 *   headless   — default false: an MV3 extension needs a real browser context (run under xvfb-run on CI).
 *   bankPort   — fixed port for the fake bank (default: any free one).
 *   sinks      — extra sinks to seed (default none: a consumer adds its own through propose-workflow).
 *   contextOptions — extra Playwright options for the browser context (baseURL, locale, timezoneId…), so a
 *                consumer's suite can keep using its own relative-URL helpers in this browser.
 *   browserType — the consumer's own `chromium` (from its @playwright/test), so its `expect` recognises the
 *                pages and locators; defaults to the one Habeas depends on.
 * Returns { context, extensionId, bank, source, approveConsent, capturedAuth, close }.
 */
export async function launchHabeasWithFakeBank({ headless = false, bankPort = 0, sinks = [], contextOptions = {}, browserType = chromium } = {}) {
  const bank = await startMockBank({ port: bankPort });
  const source = fakeBankSource(bank.port);
  const extDir = buildTestExtension();
  const context = await browserType.launchPersistentContext('', {
    ...contextOptions,
    headless,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-sandbox'],
  });
  const close = async () => {
    await context.close().catch(() => {});
    bank.server.close();
    rmSync(extDir, { recursive: true, force: true });
  };

  try {
    const id = await extensionId(context);

    // Seed: the fake source installed (as from the marketplace) and enabled as a datasource, with its
    // capture scripts registered — what enabling a source in Settings does.
    const opts = await context.newPage();
    await opts.goto(`chrome-extension://${id}/src/ui/options.html`);
    await opts.evaluate(async ([src, extraSinks]) => {
      const c = globalThis.browser ?? globalThis.chrome;
      await c.storage.local.set({
        'habeas:config': { version: 1, datasources: [{ id: src.id, adapter: src.id, enabled: true, options: {} }], sinks: extraSinks, routes: [] },
        'habeas:sources': [src],
      });
      const { registerCapture } = await import(c.runtime.getURL('src/lib/capture.js'));
      await registerCapture(src);
    }, [source, sinks]);

    // Log into the fake bank: its SPA calls its API with a JWT and the page hook captures it.
    const site = await context.newPage();
    await site.goto(`${bank.origin}/`);
    await site.waitForFunction(() => document.getElementById('t')?.textContent.startsWith('loaded'), null, { timeout: 15000 });
    const authKey = 'auth:localhost:' + bank.port;
    let auth = null;
    for (let i = 0; i < 60 && !auth; i++) {
      auth = await readStorage(opts, 'session', authKey);
      if (!auth) await opts.waitForTimeout(250);
    }
    if (!auth || !/eyJ/.test((auth.merged || {}).authorization || '')) throw new Error('Habeas did not capture the fake bank session');
    await opts.close();

    // Approve the next consent screen Habeas opens (propose-workflow, register-sink, off-site consent…).
    // Clicks the screen's primary action — what a user does after reading it.
    const approveConsent = async ({ timeout = 15000 } = {}) => {
      const isAuthorize = (p) => p.url().includes('/src/ui/authorize.html');
      const page = context.pages().find(isAuthorize) || await context.waitForEvent('page', { predicate: isAuthorize, timeout });
      await page.waitForLoadState('domcontentloaded');
      const approve = page.locator('#allow');
      await approve.waitFor({ state: 'visible', timeout });
      await approve.click();
      return page;
    };

    const capturedAuth = () => readStorageFromNewPage(context, id, 'session', authKey);
    return { context, extensionId: id, bank, source, approveConsent, capturedAuth, close };
  } catch (e) {
    await close();
    throw e;
  }
}

async function readStorageFromNewPage(context, id, area, key) {
  const p = await context.newPage();
  try {
    await p.goto(`chrome-extension://${id}/src/ui/options.html`);
    return await readStorage(p, area, key);
  } finally {
    await p.close();
  }
}
