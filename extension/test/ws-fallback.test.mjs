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
import { wsSession, isContentBlocked, wsWithFallback } from '../src/lib/pagefetch.js';

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
