// Trade Republic lists over a WebSocket opened inside the site's own tab, so the handshake carries the
// user's session. In Firefox that socket is refused before it opens: the page's own CSP (`connect-src`)
// applies to a script an extension injects, in the MAIN world and the ISOLATED one alike, and the
// constructor throws NS_ERROR_CONTENT_BLOCKED. Chrome exempts injected scripts from the page CSP, which is
// why the identical source works there. Measured against Firefox 153, not assumed.
//
// So: try the page first — it is what works today and what carries the session most faithfully — and only
// when the page REFUSES to open the socket at all, run the same exchange from the extension's own context,
// where no page CSP applies. Any other failure is a real failure and must surface as one: silently changing
// context on, say, an auth error would hide it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wsSession, isContentBlocked, wsWithFallback, isFirefox, makePageWs } from '../src/lib/pagefetch.js';

// A WebSocket that speaks the server's side of the protocol, so the exchange is exercised for real.
function installFakeWs(frames) {
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; setTimeout(() => this.onopen && this.onopen(), 0); }
    send(s) {
      this.sent.push(s);
      if (s.startsWith('connect ')) { setTimeout(() => this.onmessage && this.onmessage({ data: 'connected' }), 0); return; }
      const m = s.match(/^sub (\d+) /);
      if (m) { const id = m[1]; const body = frames.shift(); if (body != null) setTimeout(() => this.onmessage && this.onmessage({ data: id + ' A ' + body }), 0); }
    }
    close() {}
  }
  globalThis.WebSocket = FakeWS;
}

test('the exchange itself runs anywhere there is a WebSocket — page or background', async () => {
  // The point of the refactor: one implementation, used in both contexts. If it needed anything from the
  // page it could not run in the background, and the fallback would be impossible.
  installFakeWs(['{"items":[{"id":"a"},{"id":"b"}]}']);
  const out = await wsSession({ url: 'wss://x.test', sub: { type: 'timelineTransactions' }, itemsPath: 'items' });
  assert.deepEqual(out.items.map((i) => i.id), ['a', 'b']);
});

test('a CSP refusal is recognised — and nothing else is mistaken for one', () => {
  assert.equal(isContentBlocked('[Exception... "The load for this content was blocked."  nsresult: "0x805e0006 (NS_ERROR_CONTENT_BLOCKED)"]'), true);
  assert.equal(isContentBlocked('NS_ERROR_CONTENT_BLOCKED'), true);
  assert.equal(isContentBlocked('ws error'), false, 'a socket that opened and then failed is a real failure');
  assert.equal(isContentBlocked('sub failed'), false, 'so is a rejected subscription');
  assert.equal(isContentBlocked(''), false);
  assert.equal(isContentBlocked(undefined), false);
});

test('the page is tried first, and when it works the background is never used', async () => {
  let bg = 0;
  const ws = wsWithFallback(async () => ({ items: [{ id: 'from-page' }] }), async () => { bg++; return { items: [] }; });
  const out = await ws({ url: 'wss://x.test' });
  assert.deepEqual(out.items, [{ id: 'from-page' }]);
  assert.equal(bg, 0, 'Chrome must keep behaving exactly as it does now');
});

test('only a CSP refusal falls back to the extension context', async () => {
  let bg = 0;
  const ws = wsWithFallback(
    async () => ({ items: [], error: 'NS_ERROR_CONTENT_BLOCKED' }),
    async () => { bg++; return { items: [{ id: 'from-background' }] }; });
  const out = await ws({ url: 'wss://x.test' });
  assert.equal(bg, 1, 'the blocked page attempt is retried outside the page');
  assert.deepEqual(out.items, [{ id: 'from-background' }]);
  assert.equal(out.viaBackground, true, 'and it says where the data came from');
});

test('a genuine failure is reported, not quietly retried somewhere else', async () => {
  let bg = 0;
  const ws = wsWithFallback(async () => ({ items: [], error: 'ws error' }), async () => { bg++; return { items: [] }; });
  const out = await ws({ url: 'wss://x.test' });
  assert.equal(bg, 0, 'switching context on a real error would hide it');
  assert.equal(out.error, 'ws error');
});

test('if the fallback is blocked too, the original refusal is what gets reported', async () => {
  // Otherwise the user is told about the second attempt and never learns why the first was refused.
  const ws = wsWithFallback(
    async () => ({ items: [], error: 'NS_ERROR_CONTENT_BLOCKED' }),
    async () => ({ items: [], error: 'ws error' }));
  const out = await ws({ url: 'wss://x.test' });
  assert.match(out.error, /CONTENT_BLOCKED/);
  assert.match(out.error, /ws error/, 'and what the fallback then hit, so both are visible');
});

// ---------------------------------------------------------------- Chrome must not be touched

test('Chrome keeps the path it already had; only Firefox gets the fallback', () => {
  // A problem in one browser must not change the browser that does not have it — and this one cannot be
  // tested against the real service from here, which is exactly when not touching it matters most.
  const src = readFileSync(new URL('../src/lib/pagefetch.js', import.meta.url), 'utf8');
  assert.match(src, /pf\.ws = isFirefox\(\) \? wsWithFallback\(makePageWs\(tabId\), makeBackgroundWs\(\)\) : makePageWs\(tabId\)/,
    'the fallback is reached only on Firefox');
  assert.equal(isFirefox(), false, 'and node, like Chrome, is not Firefox');
});

test('Firefox is recognised by a Firefox-only API, not by sniffing a user agent', () => {
  const saved = globalThis.browser;
  globalThis.browser = { runtime: { getBrowserInfo: () => {} } };
  try { assert.equal(isFirefox(), true); } finally { if (saved) globalThis.browser = saved; else delete globalThis.browser; }
  globalThis.browser = { runtime: {} }; // Chrome's shim shape: present, but no getBrowserInfo
  try { assert.equal(isFirefox(), false, 'a browser namespace alone is not Firefox'); }
  finally { if (saved) globalThis.browser = saved; else delete globalThis.browser; }
});

test('the injected protocol and the shared one stay identical', () => {
  // Chrome's path keeps its own inline copy so it cannot be disturbed. The cost of that is two copies, and
  // the risk of two copies is that they drift. Compare them instead of trusting they will not.
  const src = readFileSync(new URL('../src/lib/pagefetch.js', import.meta.url), 'utf8');
  // The promise body of each, delimited by matching braces rather than by guesswork about where it ends.
  const bodyAfter = (text, marker) => {
    const from = text.indexOf(marker); if (from < 0) return null;
    let i = text.indexOf('{', from), depth = 0;
    for (let k = i; k < text.length; k++) {
      if (text[k] === '{') depth++;
      else if (text[k] === '}' && --depth === 0) return text.slice(i + 1, k);
    }
    return null;
  };
  const strip = (t) => t.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const inline = bodyAfter(src, 'func: (c) => new Promise((resolve) => {');
  const shared = bodyAfter(wsSession.toString(), 'new Promise((resolve) => {');
  assert.ok(inline && shared, 'both bodies must be locatable');
  assert.equal(strip(shared), strip(inline),
    'the two copies of the WebSocket exchange have drifted — change both or neither');
});
