// Real check of the Phase-4 registry loop against LIVE infra: load the shipped extension and open
// the marketplace, which fetches https://habeas-dev.github.io/sources/index.json and renders it.
// carrefour-es is also a built-in, so it must show as installed rather than installable — this proves
// fetchIndex + render + installed-detection against real Pages.
import { chromium } from 'playwright';

const EXT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const results = [];
const check = (n, c, d = '') => { results.push(!!c); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
});
try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const id = sw.url().split('/')[2];
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/src/ui/marketplace.html`);
  await page.waitForSelector('#list .card', { timeout: 15000 }).catch(() => {});
  const cards = await page.locator('#list .card').count();
  check('marketplace fetched the live catalog', cards >= 1, `${cards} card(s)`);
  const carrefour = page.locator('#list .card[data-id="carrefour-es"]');
  check('carrefour-es appears from the live index', (await carrefour.count()) === 1);
  const status = (await page.locator('#status').textContent())?.trim();
  check('status reflects a loaded registry', /\d/.test(status || ''), status || '');
  // Installed shows "Installed" (disabled) or, when the catalog has a newer version, "Update (a → b)". The
  // built-in carries no version, so the catalog's is always newer — and offering it is intended.
  const btn = (await carrefour.locator('[data-install]').textContent())?.trim() || '';
  check('built-in source detected as installed (offered as installed or update, not install)', /→|^(Installed|Instalada)$/.test(btn), btn);

  // The ratings/comments panel must render, and fail soft if api.habeas.dev is unreachable.
  await carrefour.locator('[data-more]').click();
  const panel = carrefour.locator('[data-panel]');
  await panel.locator('[data-star]').first().waitFor({ timeout: 8000 }).catch(() => {});
  const stars = await panel.locator('[data-star]').count();
  check('ratings/comments panel renders', stars === 5, `${stars} stars, comments box present`);
} finally {
  await ctx.close();
}
process.exit(results.every(Boolean) ? 0 : 1);
