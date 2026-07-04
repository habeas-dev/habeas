// Real check of the Phase-4 registry loop against LIVE infra: load the shipped extension and open
// the marketplace, which fetches https://habeas-dev.github.io/sources/index.json and renders it.
// (The only published source today is carrefour-es, which is also a built-in, so it shows as
// already installed — this proves fetchIndex + render + installed-detection against real Pages.)
import { chromium } from 'playwright';

const EXT = '/home/user/proyectos/habeas/extension';
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
  const disabled = await carrefour.locator('button').isDisabled();
  const btn = (await carrefour.locator('button').textContent())?.trim();
  check('built-in source shown as already installed (button disabled)', disabled, btn || '');
} finally {
  await ctx.close();
}
process.exit(results.every(Boolean) ? 0 : 1);
