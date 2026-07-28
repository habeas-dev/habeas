import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub chrome.cookies before importing the module (ext.js reads globalThis.chrome at load).
const removed = [];
globalThis.chrome = {
  cookies: {
    // Partitioned cookies (CHIPS) are returned ONLY when a partitionKey is supplied — mirrors Chrome. The
    // WiZink session cookie 'sess' lives in the https://www.wizink.es partition; the unpartitioned getAll
    // (no partitionKey) never sees it, which is why the wipe silently stopped removing it.
    getAll: async ({ domain, partitionKey }) => {
      if (domain !== 'wizink.es') return [];
      if (partitionKey) {
        return partitionKey.topLevelSite === 'https://www.wizink.es'
          ? [{ name: 'sess', domain: 'www.wizink.es', path: '/', secure: true, partitionKey }]
          : [];
      }
      return [{ name: 'a', domain: '.wizink.es', path: '/', secure: true }, { name: 'b', domain: 'www.wizink.es', path: '/x', secure: false }];
    },
    remove: async (o) => { removed.push(o); },
  },
};
const { clearSiteCookies, siteBaseUrl } = await import('../src/lib/pagefetch.js');

test('siteBaseUrl prefers openUrl (the account/purchases page), then loginUrl, then the site root', () => {
  // openUrl wins — the tab lands on the user's data + loads the SPA whose CSP allows the API host.
  assert.equal(siteBaseUrl({ openUrl: 'https://www.carrefour.es/myaccount/#/area-privada/mis-compras', auth: { loginUrl: 'https://www.carrefour.es/login' }, api: { host: 'https://pro.api.carrefour.es' } }), 'https://www.carrefour.es/myaccount/#/area-privada/mis-compras');
  // no openUrl → falls back to loginUrl (WiZink lands the logged-out user on /login)
  assert.equal(siteBaseUrl({ auth: { loginUrl: 'https://www.wizink.es/login' }, api: { host: 'https://www.wizink.es' } }), 'https://www.wizink.es/login');
  // neither → derive the site root from match/host
  assert.equal(siteBaseUrl({ match: ['https://www.example.com/*'], api: { host: 'https://api.example.com' } }), 'https://www.example.com/');
});

test('clearSiteCookies removes every cookie for the domain (subdomains + http/https + partitioned)', async () => {
  const n = await clearSiteCookies('wizink.es');
  assert.equal(n, 3); // a, b (unpartitioned) + sess (partitioned)
  assert.equal(removed[0].url, 'https://wizink.es/');
  assert.equal(removed[1].url, 'http://www.wizink.es/x');
  assert.equal(removed[0].name, 'a');
  // the partitioned session cookie is removed WITH its partitionKey (remove fails silently without it)
  const sess = removed.find((r) => r.name === 'sess');
  assert.ok(sess, 'partitioned cookie was removed');
  assert.equal(sess.url, 'https://www.wizink.es/');
  assert.deepEqual(sess.partitionKey, { topLevelSite: 'https://www.wizink.es' });
});

test('clearSiteCookies returns 0 for an unknown domain', async () => {
  assert.equal(await clearSiteCookies('example.com'), 0);
});
