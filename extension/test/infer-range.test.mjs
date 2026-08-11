import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferRange, inferNextIsUrl, inferMoreFlag, inferWindow } from '../src/runtime/inferextras.js';

const TODAY = Date.parse('2026-08-11T10:00:00Z');
const day = (n) => new Date(TODAY - n * 86400000).toISOString().slice(0, 10);
const epoch = (n) => Math.floor((TODAY - n * 86400000) / 1000);

// ---------------------------------------------------------------- list.range

test('the date parameter pair the SPA used becomes the range', () => {
  const s = [{ url: `https://api.demo.test/mov?fromDate=${day(89)}&toDate=${day(0)}&limit=50` }];
  assert.deepEqual(inferRange(s), { from: 'fromDate', to: 'toDate', format: 'date' });
});

test('a one-sided range is reported as one-sided, not invented', () => {
  const s = [{ url: `https://api.demo.test/mov?fechaDesde=${day(30)}&limit=50` }];
  assert.deepEqual(inferRange(s), { from: 'fechaDesde', format: 'date' });
});

test('epoch seconds and milliseconds are told apart', () => {
  assert.equal(inferRange([{ url: `https://api.demo.test/f?start=${epoch(60)}&end=${epoch(0)}` }]).format, 'epoch');
  assert.equal(inferRange([{ url: `https://api.demo.test/f?start=${(TODAY - 60 * 86400000)}&end=${TODAY}` }]).format, 'epochMs');
});

test('a full ISO timestamp needs no format — that is the runtime default', () => {
  const from = new Date(TODAY - 30 * 86400000).toISOString();
  const got = inferRange([{ url: `https://api.demo.test/f?since=${encodeURIComponent(from)}` }]);
  assert.equal(got.from, 'since');
  assert.ok(!('format' in got), `an ISO range should not declare a format: ${JSON.stringify(got)}`);
});

test('no date parameter, no range', () => {
  assert.equal(inferRange([{ url: 'https://api.demo.test/mov?page=2&size=50' }]), null);
  assert.equal(inferRange([]), null);
  assert.equal(inferRange(null), null);
});

test('the window is also read from an epoch parameter, so range and window agree', () => {
  const got = inferWindow([{ url: `https://api.demo.test/f?start=${epoch(89)}&end=${epoch(0)}` }], TODAY);
  assert.equal(got.maxAgeDays, 89);
});

// ---------------------------------------------------------------- nextIsUrl

test('a cursor that is a whole URL is flagged as one', () => {
  const json = { items: [], _links: { nextPage: { href: 'https://api.demo.test/mov?memento=abc' } } };
  assert.equal(inferNextIsUrl(json, '_links.nextPage.href'), true);
  assert.equal(inferNextIsUrl({ next: '/v1/mov?page=2' }, 'next'), true);
});

test('an opaque cursor token is not a URL', () => {
  assert.equal(inferNextIsUrl({ next: 'eyJvZmZzZXQiOjUwfQ' }, 'next'), false);
  assert.equal(inferNextIsUrl({ next: null }, 'next'), false);
  assert.equal(inferNextIsUrl({}, 'next'), false);
  assert.equal(inferNextIsUrl(null, 'next'), false);
});

// ---------------------------------------------------------------- morePath / moreValue

test('a flag that flips across the captured pages says when to keep going', () => {
  // Two pages said "there is more", the last one said there is not. The majority value is the one that
  // means continue.
  const pages = [
    { json: { movs: [1], masMovimientos: true } },
    { json: { movs: [2], masMovimientos: true } },
    { json: { movs: [3], masMovimientos: false } },
  ];
  assert.deepEqual(inferMoreFlag(pages), { morePath: 'masMovimientos', moreValue: true });
});

test('a non-boolean flag keeps its own value, not a coerced one', () => {
  const pages = [
    { json: { data: [], hasMore: 'S' } }, { json: { data: [], hasMore: 'S' } }, { json: { data: [], hasMore: 'N' } },
  ];
  assert.deepEqual(inferMoreFlag(pages), { morePath: 'hasMore', moreValue: 'S' });
});

test('a nested flag yields its dotted path', () => {
  const pages = [
    { json: { page: { hasNext: true } } }, { json: { page: { hasNext: true } } }, { json: { page: { hasNext: false } } },
  ];
  assert.equal(inferMoreFlag(pages).morePath, 'page.hasNext');
});

test('without enough pages, or without a flip, nothing is claimed', () => {
  // Never saw it turn off: we do not know which value means "stop".
  assert.equal(inferMoreFlag([{ json: { hasMore: true } }, { json: { hasMore: true } }, { json: { hasMore: true } }]), null);
  // Two pages is a tie — no majority, so no way to tell which value means continue.
  assert.equal(inferMoreFlag([{ json: { hasMore: true } }, { json: { hasMore: false } }]), null);
  assert.equal(inferMoreFlag([]), null);
});

test('a field that merely flips but is not a continuation flag is ignored', () => {
  const pages = [
    { json: { items: [], status: 'ok' } }, { json: { items: [], status: 'ok' } }, { json: { items: [], status: 'empty' } },
  ];
  assert.equal(inferMoreFlag(pages), null);
});

// ---------------------------------------------------------------- wiring into the drafter

test('a drafted source asks for a window ending today, not the day it was recorded', async () => {
  const { draftAdapterFromSamples } = await import('../src/runtime/infer.js');
  const from = new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const items = Array.from({ length: 4 }, (_, i) => ({ id: 'M' + i, fecha: '2026-02-0' + (i + 1), importe: i + 1, concepto: 'Mov ' + i }));
  const r = draftAdapterFromSamples([{
    url: `https://api.demo.test/v1/mov?fromDate=${from}&toDate=${to}&limit=50`,
    method: 'GET', status: 200, reqHeaders: {}, json: { movements: items },
  }], {});
  assert.ok(r.ok, `draft failed: ${r.reason || ''}`);
  assert.deepEqual(r.draft.api.list.range, { from: 'fromDate', to: 'toDate', format: 'date' });
  // The captured dates must not survive as static params, or every run would re-ask for that same day.
  const params = r.draft.api.list.params || {};
  assert.ok(!('fromDate' in params) && !('toDate' in params),
    `stale captured dates left in params: ${JSON.stringify(params)}`);
  assert.equal(params.limit, '50', 'a genuine page-size param should still be kept');
});
