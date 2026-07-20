import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/handler.mjs';
import { memoryStore } from '../src/store-memory.mjs';

const T0 = 1_000_000;
const env = (store, client = 'c1', now = T0) => ({ store, now: () => now, clientId: async () => client, adminToken: 'ADMIN' });
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

// ---- handoff collaboration workflow ----
const BUNDLE = { habeasHandoff: 1, kind: 'redacted-recording', domain: 'financieraelcorteingles.es', counts: { samples: 2 }, samples: [{ url: 'https://x/api?type=CLOSE', json: { movements: [{ amount: '[amount:EUR]' }] } }] };

test('handoff: submit validates the bundle + submitter', async () => {
  const s = memoryStore();
  assert.equal((await call(s, 'POST', '/handoff', { submitter: 'sub1', bundle: { nope: 1 } })).status, 400);
  assert.equal((await call(s, 'POST', '/handoff', { bundle: BUNDLE })).status, 400); // no submitter
  const r = await call(s, 'POST', '/handoff', { submitter: 'sub1', handle: 'Dave', bundle: BUNDLE });
  const body = await r.json();
  assert.equal(r.status, 200); assert.ok(body.id); assert.equal(body.status, 'new');
});

test('handoff: team list is token-gated; submitter reads only its own', async () => {
  const s = memoryStore();
  const { id } = await (await call(s, 'POST', '/handoff', { submitter: 'sub1', bundle: BUNDLE })).json();
  assert.equal((await call(s, 'GET', '/handoff')).status, 401);                       // no token
  const list = await (await call(s, 'GET', '/handoff?token=ADMIN')).json();
  assert.equal(list.length, 1); assert.equal(list[0].domain, 'financieraelcorteingles.es');
  assert.equal((await call(s, 'GET', `/handoff/${id}?submitter=WRONG`)).status, 401);  // wrong submitter
  const mine = await (await call(s, 'GET', `/handoff/${id}?submitter=sub1`)).json();
  assert.equal(mine.status, 'new'); assert.deepEqual(mine.messages, []);
  assert.equal(mine.bundle, undefined);                                                // submitter view omits the bundle
});

test('handoff: two-way thread + status transitions + attribution', async () => {
  const s = memoryStore();
  const { id } = await (await call(s, 'POST', '/handoff', { submitter: 'sub1', handle: 'Dave', bundle: BUNDLE })).json();

  // team asks a question → needs_info
  const q = await call(s, 'POST', `/handoff/${id}/messages?token=ADMIN`, { text: 'What is monthFilter?' });
  assert.equal((await q.json()).from, 'team');
  assert.equal((await (await call(s, 'GET', `/handoff/${id}?submitter=sub1`)).json()).status, 'needs_info');

  // a stranger cannot post to the thread
  assert.equal((await call(s, 'POST', `/handoff/${id}/messages`, { submitter: 'WRONG', text: 'hi' })).status, 401);

  // submitter replies → in_review
  await call(s, 'POST', `/handoff/${id}/messages`, { submitter: 'sub1', text: 'monthFilter=202506' });
  const view = await (await call(s, 'GET', `/handoff/${id}?submitter=sub1`)).json();
  assert.equal(view.status, 'in_review');
  assert.deepEqual(view.messages.map((m) => m.from), ['team', 'submitter']);

  // team publishes + links the created source (attribution)
  await call(s, 'POST', `/handoff/${id}?token=ADMIN`, { status: 'published', sourceId: 'financiera-elcorteingles-es' });
  const full = await (await call(s, 'GET', `/handoff/${id}?token=ADMIN`)).json();
  assert.equal(full.status, 'published'); assert.equal(full.sourceId, 'financiera-elcorteingles-es'); assert.equal(full.handle, 'Dave');

  // submitter inbox reflects it
  const inbox = await (await call(s, 'GET', '/submitter/sub1/handoffs')).json();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].status, 'published'); assert.equal(inbox[0].sourceId, 'financiera-elcorteingles-es');
  assert.equal(inbox[0].teamMessages, 1);
});

test('handoff: a newer submission supersedes the sender prior OPEN ones for the same domain', async () => {
  const s = memoryStore();
  const bundle = (d) => ({ ...BUNDLE, domain: d });
  const a = await (await call(s, 'POST', '/handoff', { submitter: 'sub1', bundle: bundle('feci.es') })).json();
  // team starts a question on the first (still open)
  await call(s, 'POST', `/handoff/${a.id}/messages?token=ADMIN`, { text: 'q' });
  // a more complete second submission for the SAME domain from the SAME submitter
  const b = await call(s, 'POST', '/handoff', { submitter: 'sub1', bundle: bundle('feci.es') });
  assert.equal((await b.clone().json()).superseded, 1);
  const bid = (await b.json()).id;
  // the first is now superseded (hidden from the contributor's inbox — the newer one represents it); the
  // second is new and shown.
  const inbox = await (await call(s, 'GET', '/submitter/sub1/handoffs')).json();
  const byId = Object.fromEntries(inbox.map((h) => [h.id, h.status]));
  assert.equal(byId[a.id], undefined, 'superseded submission is hidden from the inbox');
  assert.equal(byId[bid], 'new');
  // a DIFFERENT domain from the same submitter is untouched; a terminal status is not re-opened
  const other = await (await call(s, 'POST', '/handoff', { submitter: 'sub1', bundle: bundle('other.es') })).json();
  assert.equal(other.superseded, 0);
});

test('handoff: team can manually close a submission as superseded', async () => {
  const s = memoryStore();
  const { id } = await (await call(s, 'POST', '/handoff', { submitter: 'sub1', bundle: BUNDLE })).json();
  const r = await (await call(s, 'POST', `/handoff/${id}?token=ADMIN`, { status: 'superseded' })).json();
  assert.equal(r.status, 'superseded');
});

test('handoff: team attaches the authored source; the submitter can retrieve it to install', async () => {
  const s = memoryStore();
  const { id } = await (await call(s, 'POST', '/handoff', { submitter: 'sub1', bundle: BUNDLE })).json();
  const SRC = { id: 'x-es', name: 'X', schema: 'transaction@1' };
  await call(s, 'POST', `/handoff/${id}?token=ADMIN`, { status: 'authored', sourceId: 'x-es', sourceJson: SRC });
  const view = await (await call(s, 'GET', `/handoff/${id}?submitter=sub1`)).json();
  assert.equal(view.status, 'authored');
  assert.deepEqual(view.source, SRC);              // one-click install payload
  const inbox = await (await call(s, 'GET', '/submitter/sub1/handoffs')).json();
  assert.equal(inbox[0].hasSource, true);
});

test('handoff: the team is notified on a new submission and on a contributor reply, but not on its own', async () => {
  const s = memoryStore();
  const events = [];
  const envN = (store, client = 'c1', now = T0) => ({ store, now: () => now, clientId: async () => client, adminToken: 'ADMIN', notify: (e) => { events.push(e); } });
  const callN = (m, p, b, c, n) => handleRequest(req(m, p, b), envN(s, c, n));

  const { id } = await (await callN('POST', '/handoff', { submitter: 'sub1', bundle: BUNDLE })).json();
  assert.equal(events.length, 1, 'a new recording pings the team');
  assert.equal(events[0].kind, 'new');
  assert.equal(events[0].domain, BUNDLE.domain);

  // the team's OWN reply must NOT notify the team
  await callN('POST', `/handoff/${id}/messages?token=ADMIN`, { text: 'a question' });
  assert.equal(events.length, 1, 'team reply does not notify the team');

  // a contributor reply DOES notify, carrying the domain + text
  await callN('POST', `/handoff/${id}/messages`, { submitter: 'sub1', text: 'it failed again' });
  assert.equal(events.length, 2);
  assert.equal(events[1].kind, 'reply');
  assert.equal(events[1].domain, BUNDLE.domain);
  assert.equal(events[1].text, 'it failed again');
});

test('handoff: a targeted re-recording attaches to the SAME handoff (no new handoff, no supersede)', async () => {
  const s = memoryStore();
  const { id } = await (await call(s, 'POST', '/handoff', { submitter: 'sub1', bundle: BUNDLE })).json();
  await call(s, 'POST', `/handoff/${id}?token=ADMIN`, { captureRequest: { instruction: 'record the deposits list' } });
  // the contributor's guided re-recording goes to THIS handoff, not a new one
  const r = await call(s, 'POST', `/handoff/${id}/recording`, { submitter: 'sub1', bundle: { ...BUNDLE, counts: { samples: 5 } }, note: 'here it is' });
  assert.equal(r.status, 200);
  // still exactly ONE handoff for this submitter (nothing was superseded / spawned)
  const inbox = await (await call(s, 'GET', '/submitter/sub1/handoffs')).json();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].id, id);
  // the recording is attached + a submitter message landed in the SAME thread, status back to in_review
  const full = await (await call(s, 'GET', `/handoff/${id}?token=ADMIN`)).json();
  assert.equal(full.status, 'in_review');
  assert.equal(full.recordings.length, 1);
  assert.equal(full.recordings[0].note, 'here it is');
  assert.equal(full.messages[full.messages.length - 1].from, 'submitter');
  // the team can fetch the supplementary bundle; a stranger cannot post one
  const rec = await (await call(s, 'GET', `/handoff/${id}/recording/${full.recordings[0].seq}?token=ADMIN`)).json();
  assert.equal(rec.bundle.counts.samples, 5);
  assert.equal((await call(s, 'POST', `/handoff/${id}/recording`, { submitter: 'WRONG', bundle: BUNDLE })).status, 401);
});

test('handoff: a targeted capture request rides the timeline with its instruction + endpoint hint', async () => {
  const s = memoryStore();
  const { id } = await (await call(s, 'POST', '/handoff', { submitter: 'sub1', bundle: BUNDLE })).json();
  // team asks for a specific, guided capture (plain instruction + endpoint hint + a value to reveal)
  const r = await call(s, 'POST', `/handoff/${id}?token=ADMIN`, { captureRequest: { instruction: 'Open your list of accounts and go to the deposits section.', endpoint: '/tams/v1/accounts', reveal: 'filter' } });
  assert.equal(r.status, 200);
  const view = await (await call(s, 'GET', `/handoff/${id}?submitter=sub1`)).json();
  assert.equal(view.status, 'needs_info', 'a capture request awaits the contributor');
  const cr = view.messages.filter((m) => m.captureRequest);
  assert.equal(cr.length, 1);
  assert.equal(cr[0].from, 'team');
  assert.equal(cr[0].text, 'Open your list of accounts and go to the deposits section.', 'the plain instruction is the message body');
  assert.equal(cr[0].captureRequest.endpoint, '/tams/v1/accounts');
  assert.equal(cr[0].captureRequest.reveal, 'filter');
  // instruction is required
  assert.equal((await call(s, 'POST', `/handoff/${id}?token=ADMIN`, { captureRequest: { endpoint: '/x' } })).status, 400);
});

test('handoff: each attached version is a timeline message, and history is preserved', async () => {
  const s = memoryStore();
  const { id } = await (await call(s, 'POST', '/handoff', { submitter: 'sub1', bundle: BUNDLE })).json();
  const V1 = { id: 'x-es', name: 'X', schema: 'transaction@1', version: '2026-07-19' };
  const V2 = { id: 'x-es', name: 'X', schema: 'transaction@1', version: '2026-07-20' };
  // two successive version sends, each with an accompanying plain note
  await call(s, 'POST', `/handoff/${id}?token=ADMIN`, { status: 'authored', sourceJson: V1, message: 'First build to test' });
  await call(s, 'POST', `/handoff/${id}?token=ADMIN`, { sourceJson: V2, message: 'This fixes the statement download' });

  const view = await (await call(s, 'GET', `/handoff/${id}?submitter=sub1`)).json();
  // both versions ride the conversation timeline, in order, each carrying its own source + note
  const vmsgs = view.messages.filter((m) => m.source);
  assert.equal(vmsgs.length, 2, 'both versions are timeline messages');
  assert.equal(vmsgs[0].from, 'team');
  assert.equal(vmsgs[0].source.version, '2026-07-19');
  assert.equal(vmsgs[0].text, 'First build to test');
  assert.equal(vmsgs[1].source.version, '2026-07-20');
  // the latest source stays available for the backward-compatible one-click install
  assert.deepEqual(view.source, V2);
  // a plain text reply is NOT a version message
  await call(s, 'POST', `/handoff/${id}/messages`, { submitter: 'sub1', text: 'ok, testing' });
  const view2 = await (await call(s, 'GET', `/handoff/${id}?submitter=sub1`)).json();
  assert.equal(view2.messages.filter((m) => m.source).length, 2);
  assert.equal(view2.messages[view2.messages.length - 1].text, 'ok, testing');
  assert.ok(!view2.messages[view2.messages.length - 1].source);
});
