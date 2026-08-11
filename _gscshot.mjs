import { chromium } from 'playwright';

// Connect to the already-open GSC Chrome (remote-debugging :9222) and screenshot the ACTIVE page. Run this
// whenever the user has navigated to a report they want me to read. Output path via argv[2].
const out = process.argv[2] || '/tmp/gsc.png';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const pages = ctx.pages();
// pick the visible GSC page (the front tab)
let page = pages.find((p) => /search\.google\.com\/search-console/.test(p.url())) || pages[pages.length - 1];
try { await page.bringToFront(); } catch {}
await page.screenshot({ path: out, fullPage: true }).catch(async () => { await page.screenshot({ path: out }); });
console.log('shot:', out, '| url:', page.url());
await browser.close(); // detaches CDP only; does NOT close the user's browser
