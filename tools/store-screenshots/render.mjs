// Render the store screenshots (screenshots.html) to 1280×800 PNGs, one per shot.
// Usage: node tools/store-screenshots/render.mjs           → promo shots (Chrome Web Store, AMO)
//        node tools/store-screenshots/render.mjs --plain   → the same panels WITHOUT the headline,
//                                                            for listings that want a screenshot of
//                                                            the app rather than a promo image
//                                                            (AlternativeTo). Writes out/plain/.
// Needs Playwright + a Chromium build (npx playwright install chromium).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const PLAIN = process.argv.includes('--plain');
const out = join(here, 'out', ...(PLAIN ? ['plain'] : []));
mkdirSync(out, { recursive: true });

// The version shown in the mockups comes from the manifest, so it cannot drift: it read v0.6.0 while
// the extension was on 0.9.12, and nobody notices a stale string inside a promo image.
const VERSION = JSON.parse(readFileSync(join(here, '..', '..', 'extension', 'manifest.json'), 'utf8')).version;

const SHOTS = 5; // keep in sync with the number of <section class="shot"> in each HTML file
const LANGS = [{ file: 'screenshots.html', suffix: '' }, { file: 'screenshots-es.html', suffix: '-es' }];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
for (const { file, suffix } of LANGS) {
  await page.goto('file://' + join(here, file), { waitUntil: 'networkidle' });
  for (let n = 1; n <= SHOTS; n++) {
    await page.evaluate(([k, plain]) => {
      document.body.setAttribute('data-shot', String(k));
      if (plain) document.body.setAttribute('data-plain', '1'); else document.body.removeAttribute('data-plain');
    }, [n, PLAIN]);
    await page.evaluate((v) => document.querySelectorAll('.vtag').forEach((e) => { e.textContent = 'v' + v; }), VERSION);
    await page.waitForTimeout(120);
    const path = join(out, `habeas-shot${suffix}-${n}.png`);
    await page.screenshot({ path });
    console.log('wrote', path);
  }
}
await browser.close();
