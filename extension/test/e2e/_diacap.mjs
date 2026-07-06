import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = process.argv[2];
const START = process.argv[3] || 'https://www.dia.es/';
// Keep app/auth headers (not cookies) so we can replay them; skip trackers/CDN noise.
const HDR_KEEP = /^(authorization|x-[a-z0-9-]+|[a-z0-9-]*-token|[a-z0-9-]*-csrf|requestorigin|content-type|accept|referer|apollographql-[a-z-]+|store-[a-z-]+|dia-[a-z-]+|channel|banner|apikey|ocp-apim-[a-z-]+)$/i;
const SKIP = /google|gstatic|googletag|facebook|doubleclick|hotjar|datadome|akamai|analytics|segment|cookiebot|clarity|criteo|adservice|onetrust|newrelic|sentry|optimizely|cookielaw|tiktok|bing|yandex|cdn-cgi/i;
fs.writeFileSync(OUT, '');

const browser = await chromium.launch({
  headless: false,
  channel: 'chrome-beta', // the REAL Google Chrome (beta) binary, not Playwright's Chromium
  ignoreDefaultArgs: ['--enable-automation'], // drop the automation flag (kills navigator.webdriver + the infobar)
  args: ['--start-maximized', '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
});
const ctx = await browser.newContext({ locale: 'es-ES', viewport: null });
// Hide the remaining automation tells before any page script runs.
await ctx.addInitScript(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  try { window.chrome = window.chrome || { runtime: {} }; } catch (e) {}
});
const page = await ctx.newPage();
const seen = new Set();

ctx.on('response', async (res) => {
  try {
    const req = res.request();
    const url = res.url();
    if (SKIP.test(url)) return;
    const ct = res.headers()['content-type'] || '';
    if (!/json|graphql/i.test(ct)) return;
    const method = req.method();
    let body = ''; try { body = (await res.text()).slice(0, 4000); } catch (e) {}
    const reqHeaders = {};
    for (const [k, v] of Object.entries(req.headers())) if (HDR_KEEP.test(k) && k.toLowerCase() !== 'cookie') reqHeaders[k] = v;
    let postData = ''; try { postData = (req.postData() || '').slice(0, 1000); } catch (e) {}
    fs.appendFileSync(OUT, JSON.stringify({ t: Date.now(), method, url, status: res.status(), reqHeaders, postData, bodySnippet: body }) + '\n');
    const key = method + ' ' + url.split('?')[0];
    if (!seen.has(key)) { seen.add(key); console.log('CAPTURED', method, url.slice(0, 140)); }
  } catch (e) {}
});

await page.goto(START, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('goto:', e.message));
console.log('READY — log in, go to your purchases, and open a detail. Close the window when done.');
await new Promise((resolve) => browser.on('disconnected', resolve));
console.log('BROWSER CLOSED — captures at ' + OUT);
