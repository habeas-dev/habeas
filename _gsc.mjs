import { chromium } from 'playwright';

// Headed real-Chrome on the user's display, opened at Google Search Console, with a remote-debugging port so a
// separate short script can grab screenshots ON DEMAND while the user navigates/logs in. No data is stored here.
const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  args: ['--remote-debugging-port=9222', '--disable-blink-features=AutomationControlled', '--start-maximized'],
  ignoreDefaultArgs: ['--enable-automation'],
});
const ctx = await browser.newContext({ viewport: null });
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();
await page.goto('https://search.google.com/search-console').catch(() => {});
console.log('READY — log into Google, pick the habeas.dev property, open the report you want me to see.');
await new Promise((r) => browser.on('disconnected', r));
console.log('CLOSED');
