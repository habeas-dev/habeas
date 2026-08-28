// The external-hooks bridge relays a site's postMessage to the background and posts the reply back.
// It asked for that reply Chrome-style — sendMessage(msg, callback) — but Firefox's browser.* APIs are
// promise-only and read a second argument as `options`, so a function there is a type error. The bridge
// caught it and answered the page `{ ok: false, error: … }`, which means every site integration failed
// on Firefox while working on Chrome. Same shape as the keepalive bug: a Chrome-style callback silently
// lost under the browser/chrome shim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/content/extbridge.js'), 'utf8');

// Load the bridge IIFE against a fake page + a chosen runtime.
function loadBridge(runtime) {
  const listeners = [], posted = [];
  const win = {
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: (m) => posted.push(m),
  };
  const g = { browser: { runtime }, window: win, location: { origin: 'https://shop.example' } };
  g.globalThis = g;
  runInNewContext(SRC, { globalThis: g, browser: g.browser, window: win, location: g.location });
  const send = (msg) => listeners.forEach((fn) => fn({ source: win, data: msg }));
  return { send, posted };
}

// Firefox: promise-only, and strict — a function where `options` belongs is a type error.
const firefox = (onMessage) => ({
  sendMessage: (message, options) => {
    if (options !== undefined && typeof options !== 'object') throw new TypeError('Incorrect argument types for runtime.sendMessage.');
    return Promise.resolve(onMessage(message));
  },
  get lastError() { return undefined; },
});

test('the bridge gets a real answer through on Firefox', async () => {
  const { send, posted } = loadBridge(firefox(() => ({ ok: true, status: 'granted' })));
  send({ __habeasExt: 'req', api: 'status', id: 'r1', payload: {} });
  await new Promise((r) => setTimeout(r, 5));
  const res = posted.find((m) => m.__habeasExt === 'res' && m.id === 'r1');
  assert.ok(res, 'a response must reach the page');
  assert.deepEqual(res.response, { ok: true, status: 'granted' }, 'and it must be the background’s answer, not a type error');
});

test('a background failure is still reported as a failure, not swallowed', async () => {
  const runtime = { sendMessage: () => Promise.reject(new Error('receiving end does not exist')), lastError: undefined };
  const { send, posted } = loadBridge(runtime);
  send({ __habeasExt: 'req', api: 'status', id: 'r2', payload: {} });
  await new Promise((r) => setTimeout(r, 5));
  const res = posted.find((m) => m.__habeasExt === 'res' && m.id === 'r2');
  assert.ok(res && res.response.ok === false, 'the page must be told it failed');
  assert.match(res.response.error, /receiving end/, 'and why');
});

test('Chrome, which under MV3 also returns a promise, is unaffected', async () => {
  const runtime = { sendMessage: (message, cb) => (typeof cb === 'function' ? void cb({ ok: true, status: 'chrome' }) : Promise.resolve({ ok: true, status: 'chrome' })), lastError: undefined };
  const { send, posted } = loadBridge(runtime);
  send({ __habeasExt: 'req', api: 'status', id: 'r3', payload: {} });
  await new Promise((r) => setTimeout(r, 5));
  const res = posted.find((m) => m.__habeasExt === 'res' && m.id === 'r3');
  assert.ok(res, 'a response must reach the page on Chrome too');
  assert.equal(res.response.status, 'chrome');
});
