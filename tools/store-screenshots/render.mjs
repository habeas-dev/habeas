// Render the store screenshots (screenshots.html) to 1280×800 PNGs, one per shot.
// Usage: node tools/store-screenshots/render.mjs   → writes to tools/store-screenshots/out/
// Needs Playwright + a Chromium build (npx playwright install chromium).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
mkdirSync(out, { recursive: true });

const SHOTS = 5; // keep in sync with the number of <section class="shot"> in each HTML file
const LANGS = [{ file: 'screenshots.html', suffix: '' }, { file: 'screenshots-es.html', suffix: '-es' }];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
for (const { file, suffix } of LANGS) {
  await page.goto('file://' + join(here, file), { waitUntil: 'networkidle' });
  for (let n = 1; n <= SHOTS; n++) {
    await page.evaluate((k) => document.body.setAttribute('data-shot', String(k)), n);
    await page.waitForTimeout(120);
    const path = join(out, `habeas-shot${suffix}-${n}.png`);
    await page.screenshot({ path });
    console.log('wrote', path);
  }
}
await browser.close();
