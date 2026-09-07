// The `query` read hook hands a consumer a POINTER to a document (never its content). Habeas has to
// remember it did so, so a later `show-document` can re-open that exact doc — that authorization is the
// delivery ledger. But the content-collect path uses the SAME ledger to decide what it has already SENT,
// keyed `(datasource, sink)`. If a pointer were recorded there, a later collect of that same source to the
// same origin sink would treat the doc as "already delivered" and silently skip its CONTENT — the consumer
// gets a pointer and never the document it was separately entitled to. Invisible, and exactly the kind of
// under-delivery nobody notices.
//
// So pointer-handovers get their OWN ledger. This pins the two properties that matter:
//   1. recording a pointer must NOT make the doc look content-delivered (collect still sends it)
//   2. show-document must still be authorized for a pointered doc (either ledger counts)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LOCAL = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => (k == null ? { ...LOCAL } : Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, LOCAL[x]])) : { [k]: LOCAL[k] }),
  set: async (o) => { Object.assign(LOCAL, o); },
  remove: async (k) => { for (const x of [].concat(k)) delete LOCAL[x]; },
} } };

const { markDelivered, deliveredSet, markPointed, pointedSet } = await import('../src/lib/state.js');
const reset = () => { for (const k of Object.keys(LOCAL)) delete LOCAL[k]; };

test('a pointer handover does not land in the CONTENT ledger', async () => {
  reset();
  await markPointed('carrefour-es', 'ext-shop-com', ['r1', 'r2']);
  const content = await deliveredSet('carrefour-es', 'ext-shop-com');
  assert.equal(content.r1, undefined, 'a pointer must not mark the doc content-delivered');
  assert.equal(content.r2, undefined);
  const pointed = await pointedSet('carrefour-es', 'ext-shop-com');
  assert.ok(pointed.r1 && pointed.r2, 'but the pointer ledger records it');
});

test('content delivery and pointer handover are independent tables', async () => {
  reset();
  await markDelivered('carrefour-es', 'ext-shop-com', ['c1']);
  await markPointed('carrefour-es', 'ext-shop-com', ['p1']);
  const content = await deliveredSet('carrefour-es', 'ext-shop-com');
  const pointed = await pointedSet('carrefour-es', 'ext-shop-com');
  assert.deepEqual(Object.keys(content), ['c1'], 'content ledger holds only content');
  assert.deepEqual(Object.keys(pointed), ['p1'], 'pointer ledger holds only pointers');
});

test("a doc collected to a sink is not thereby 'pointered', and vice versa", async () => {
  reset();
  await markDelivered('x', 's', ['d']);
  assert.equal((await pointedSet('x', 's')).d, undefined, 'content delivery leaves the pointer ledger empty');
  reset();
  await markPointed('x', 's', ['d']);
  assert.equal((await deliveredSet('x', 's')).d, undefined, 'pointer handover leaves the content ledger empty');
});

test('show-document authorization: a doc is re-openable if content-delivered OR pointered', async () => {
  // This is the predicate show-document must use. Encoded here so the split cannot silently regress it to
  // checking only one ledger — which would either deny a pointered doc, or (the bug) rely on the content one.
  reset();
  const authorized = async (ds, sink, id) => {
    const [c, p] = await Promise.all([deliveredSet(ds, sink), pointedSet(ds, sink)]);
    return !!(c[id] || p[id]);
  };
  await markPointed('x', 's', ['viaPointer']);
  await markDelivered('x', 's', ['viaContent']);
  assert.equal(await authorized('x', 's', 'viaPointer'), true, 'a pointered doc can be re-opened');
  assert.equal(await authorized('x', 's', 'viaContent'), true, 'a content-delivered doc can be re-opened');
  assert.equal(await authorized('x', 's', 'neither'), false, 'an untouched doc cannot');
});

test('revoking a query grant drops the origin sink\'s pointer ledger, across sources', async () => {
  // A query spans every enabled source, so its pointers are spread over many "<ds>::<sink>" keys that share
  // the one origin sink. Revocation clears them by sink, without having to know which sources were hit —
  // and leaves other sinks' pointers, and the content ledger, untouched.
  reset();
  await markPointed('carrefour-es', 'ext-shop-com', ['a']);
  await markPointed('amazon',      'ext-shop-com', ['b']);
  await markPointed('carrefour-es', 'ext-other-com', ['c']); // a different consumer
  await markDelivered('carrefour-es', 'ext-shop-com', ['d']); // content, must survive
  const { forgetPointedForSink } = await import('../src/lib/state.js');
  await forgetPointedForSink('ext-shop-com');
  assert.deepEqual(await pointedSet('carrefour-es', 'ext-shop-com'), {}, 'that origin\'s pointers gone');
  assert.deepEqual(await pointedSet('amazon', 'ext-shop-com'), {}, 'across every source it touched');
  assert.ok((await pointedSet('carrefour-es', 'ext-other-com')).c, 'another consumer\'s pointers untouched');
  assert.ok((await deliveredSet('carrefour-es', 'ext-shop-com')).d, 'the content ledger is untouched');
});

// Wiring guard: the bug was `query-route` writing a pointer into the CONTENT ledger. Pin the two handlers
// to the right ledgers at the source, so a refactor can't quietly reintroduce it (the behavioural tests
// above prove the ledgers are isolated; this proves the handlers use the intended one).
test('query-route records a POINTER, never a content delivery', async () => {
  const { readFileSync } = await import('node:fs');
  const bg = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  const i = bg.indexOf("msg.type === 'habeas:query-route'");
  const j = bg.indexOf("msg.type === 'habeas:sched-run'", i);
  const route = bg.slice(i, j > i ? j : i + 4000);
  assert.match(route, /markPointed\(ds\.id, sink\.id/, 'the pointer handover goes to the pointer ledger');
  assert.ok(!/markDelivered\(/.test(route), 'and NOT to the content ledger — that was the bug');
});
