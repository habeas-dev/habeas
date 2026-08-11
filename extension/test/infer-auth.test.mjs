import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferCookies, inferLoginUrl } from '../src/runtime/inferextras.js';

// Two more fields read off the recording. All hosts and paths synthetic.

// ---------------------------------------------------------------- auth.cookies

test('a bearer API the SPA calls without credentials is declared cookie-free', () => {
  // Three live sources do this: a token-authenticated API on a separate host, called with no cookies.
  // Replaying WITH cookies is not merely redundant — it sends session cookies the SPA never sent.
  const samples = [
    { url: 'https://api.demo.test/v1/tx', cred: 'omit', reqHeaders: {} },
    { url: 'https://api.demo.test/v1/accounts', cred: 'omit', reqHeaders: {} },
  ];
  assert.equal(inferCookies(samples, 'api.demo.test'), false);
});

test('a cross-origin call that says nothing about credentials sends none, and is treated as such', () => {
  // fetch() defaults to same-origin: a call from www.demo.test to api.other.test carries no cookies.
  const samples = [{ url: 'https://api.other.test/v1/tx', reqHeaders: {} }];
  assert.equal(inferCookies(samples, 'api.other.test', 'www.demo.test'), false);
});

test('an explicit include, or a same-origin call, keeps cookies', () => {
  assert.equal(inferCookies([{ url: 'https://api.demo.test/v1/tx', cred: 'include' }], 'api.demo.test'), null);
  // Same host as the page: the default already sends cookies, so there is nothing to declare.
  assert.equal(inferCookies([{ url: 'https://www.demo.test/api/tx' }], 'www.demo.test', 'www.demo.test'), null);
});

test('one cookie-bearing call anywhere in the set is enough to keep them', () => {
  const samples = [
    { url: 'https://api.demo.test/a', cred: 'omit' },
    { url: 'https://api.demo.test/b', cred: 'include' },
  ];
  assert.equal(inferCookies(samples, 'api.demo.test'), null);
});

test('requests to other hosts are irrelevant to this source', () => {
  const samples = [
    { url: 'https://analytics.elsewhere.test/beacon', cred: 'omit' },
    { url: 'https://api.demo.test/v1/tx', cred: 'include' },
  ];
  assert.equal(inferCookies(samples, 'api.demo.test'), null);
  assert.equal(inferCookies([{ url: 'https://analytics.elsewhere.test/b', cred: 'omit' }], 'api.demo.test'), null);
});

// ---------------------------------------------------------------- auth.loginUrl

const page = (url) => ({ url });

test('the sign-in page the user actually visited becomes loginUrl', () => {
  const seen = [page('https://www.demo.test/'), page('https://www.demo.test/login.html'), page('https://www.demo.test/mi-cuenta')];
  assert.equal(inferLoginUrl(seen, 'www.demo.test'), 'https://www.demo.test/login.html');
});

test('the usual spellings are recognised, including Spanish ones', () => {
  for (const p of ['/login', '/signin', '/sign-in', '/acceso', '/entrar', '/cpc/login', '/es/iniciar-sesion']) {
    assert.equal(inferLoginUrl([page('https://www.demo.test' + p)], 'www.demo.test'),
      'https://www.demo.test' + p, `${p} not recognised`);
  }
});

test('a login page on another host is not this source’s login page', () => {
  assert.equal(inferLoginUrl([page('https://accounts.google.test/signin')], 'www.demo.test'), '');
});

test('nothing is emitted when no sign-in page was visited', () => {
  assert.equal(inferLoginUrl([page('https://www.demo.test/'), page('https://www.demo.test/pedidos')], 'www.demo.test'), '');
  assert.equal(inferLoginUrl([], 'www.demo.test'), '');
  assert.equal(inferLoginUrl(null, 'www.demo.test'), '');
});

test('a query string is dropped — a one-off redirect token is not part of the login URL', () => {
  assert.equal(inferLoginUrl([page('https://www.demo.test/login?redirect=%2Fmi-cuenta&t=abc123')], 'www.demo.test'),
    'https://www.demo.test/login');
});

test('a word that merely contains "login" is not a login page', () => {
  assert.equal(inferLoginUrl([page('https://www.demo.test/blog/inicio')], 'www.demo.test'), '');
});
