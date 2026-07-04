import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/handler.mjs';
import { memoryStore } from '../src/store-memory.mjs';

const T0 = 1_000_000;
const env = (store, client = 'c1', now = T0) => ({ store, now: () => now, clientId: async () => client });
const req = (method, path, body) => new Request('https://api.habeas.dev' + path, {
  method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
});
const call = (store, method, path, body, client, now) => handleRequest(req(method, path, body), env(store, client, now));

test('CORS preflight', async () => {
  const r = await call(memoryStore(), 'OPTIONS', '/sources/carrefour-es/ratings');
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('ratings: empty, then post, then aggregate + upsert', async () => {
  const s = memoryStore();
  assert.deepEqual(await (await call(s, 'GET', '/sources/carrefour-es/ratings')).json(), { avg: 0, count: 0 });

  let r = await (await call(s, 'POST', '/sources/carrefour-es/ratings', { stars: 4 }, 'a')).json();
  assert.deepEqual(r, { avg: 4, count: 1 });

  r = await (await call(s, 'POST', '/sources/carrefour-es/ratings', { stars: 2 }, 'a')).json(); // same client re-votes
  assert.deepEqual(r, { avg: 2, count: 1 });

  r = await (await call(s, 'POST', '/sources/carrefour-es/ratings', { stars: 5 }, 'b')).json();
  assert.deepEqual(r, { avg: 3.5, count: 2 });
});

test('ratings: reject out-of-range stars', async () => {
  const s = memoryStore();
  assert.equal((await call(s, 'POST', '/sources/x/ratings', { stars: 9 })).status, 400);
  assert.equal((await call(s, 'POST', '/sources/x/ratings', { stars: 0 })).status, 400);
  assert.equal((await call(s, 'POST', '/sources/x/ratings', { stars: 2.5 })).status, 400);
});

test('comments: post then list newest-first', async () => {
  const s = memoryStore();
  await call(s, 'POST', '/sources/carrefour-es/comments', { text: 'first', author: 'ana' }, 'a', T0);
  await call(s, 'POST', '/sources/carrefour-es/comments', { text: 'second' }, 'b', T0 + 1000);
  const list = await (await call(s, 'GET', '/sources/carrefour-es/comments')).json();
  assert.equal(list.length, 2);
  assert.equal(list[0].text, 'second');
  assert.equal(list[1].author, 'ana');
  assert.match(list[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('comments: reject empty and oversized', async () => {
  const s = memoryStore();
  assert.equal((await call(s, 'POST', '/sources/x/comments', { text: '   ' })).status, 400);
  assert.equal((await call(s, 'POST', '/sources/x/comments', { text: 'a'.repeat(1001) })).status, 400);
});

test('invalid source id and unknown routes', async () => {
  const s = memoryStore();
  assert.equal((await call(s, 'GET', '/sources/Bad_Id!/ratings')).status, 400);
  assert.equal((await call(s, 'GET', '/sources/x/unknown')).status, 404);
  assert.equal((await call(s, 'GET', '/nope')).status, 404);
  assert.equal((await (await call(s, 'GET', '/')).json()).ok, true);
});

test('rate limit kicks in after the hourly cap', async () => {
  const s = memoryStore();
  for (let i = 0; i < 30; i++) assert.equal((await call(s, 'POST', '/sources/x/comments', { text: 'hi ' + i }, 'spammer')).status, 200);
  assert.equal((await call(s, 'POST', '/sources/x/comments', { text: 'one more' }, 'spammer')).status, 429);
  // a different client is unaffected
  assert.equal((await call(s, 'POST', '/sources/x/comments', { text: 'hello' }, 'other')).status, 200);
});
