import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub chrome.cookies before importing the module (ext.js reads globalThis.chrome at load).
const removed = [];
globalThis.chrome = {
  cookies: {
    getAll: async ({ domain }) => (domain === 'wizink.es'
      ? [{ name: 'a', domain: '.wizink.es', path: '/', secure: true }, { name: 'b', domain: 'www.wizink.es', path: '/x', secure: false }]
      : []),
    remove: async (o) => { removed.push(o); },
  },
};
const { clearSiteCookies } = await import('../src/lib/pagefetch.js');

test('clearSiteCookies removes every cookie for the domain (subdomains + http/https)', async () => {
  const n = await clearSiteCookies('wizink.es');
  assert.equal(n, 2);
  assert.equal(removed[0].url, 'https://wizink.es/');
  assert.equal(removed[1].url, 'http://www.wizink.es/x');
  assert.equal(removed[0].name, 'a');
});

test('clearSiteCookies returns 0 for an unknown domain', async () => {
  assert.equal(await clearSiteCookies('example.com'), 0);
});
