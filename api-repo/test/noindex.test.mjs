import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/handler.mjs';

// An API is not a page. Google had the root filed under "crawled, currently not indexed", which is a JSON
// endpoint sitting in the index of a project whose argument is that it holds nothing. The header has to be
// on EVERY response, including errors and the CORS preflight — a crawler that only ever sees a 404 or an
// OPTIONS still learns nothing from a header that is missing there.
const env = {};

test('every response tells crawlers not to index it', async () => {
  for (const [method, path] of [['GET', '/'], ['GET', '/nope'], ['OPTIONS', '/ratings']]) {
    const res = await handleRequest(new Request(`https://api.habeas.dev${path}`, { method }), env);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow', `${method} ${path}`);
  }
});
