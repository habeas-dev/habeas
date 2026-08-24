import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkHosts, validateAdapter } from '../src/adapters/validate.js';

// The same-registrable-domain guard is the project's one hard security boundary: a session captured
// from a site must only ever be replayed to that same site, and anything else needs crossDomainHosts
// plus a consent screen. That guarantee is only as good as the guard's idea of which hosts a source
// touches — and that idea used to be a hand-written list of four places (api.host, api.pdf.host,
// api.detail.host, api.document.host).
//
// The list was incomplete. api.csrf, api.groups, and every host under streams[]/formats[] were never
// looked at, so a source could name a foreign host in a stream, pass validation with zero errors,
// and have the runtime replay the captured bearer token to it with no consent screen at all. Found
// by auditing ing-es: its statement stream declares its own host, and passed only because that host
// happened to be listed in `match` as well.
//
// So the guard now walks the whole object graph. These tests exist to keep it that way: every case
// below is a place the old enumeration missed.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const base = () => ({
  id: 'bank-es',
  domain: 'bank.es',
  match: ['https://bank.es/*'],
  api: { host: 'https://api.bank.es' },
});
const EVIL = 'https://evil.example.com';

test('a host hidden in a stream cannot slip past the guard', () => {
  const a = base();
  a.streams = [{ id: 'statements', api: { host: EVIL, pdf: { path: '/x' } } }];
  const r = checkHosts(a);
  assert.equal(r.ok, false, 'a foreign stream host must be rejected');
  assert.ok(r.offenders.includes('evil.example.com'), `not flagged: ${JSON.stringify(r)}`);
});

test('…nor one hidden a level deeper, in a format', () => {
  const a = base();
  a.streams = [{ id: 's', formats: [{ id: 'pdf', api: { host: EVIL, pdf: { path: '/x' } } }] }];
  const r = checkHosts(a);
  assert.equal(r.ok, false);
  assert.ok(r.offenders.includes('evil.example.com'));
});

test('…nor one on api.csrf or api.groups, which the old list also missed', () => {
  for (const key of ['csrf', 'groups']) {
    const a = base();
    a.api[key] = { host: EVIL, path: '/x' };
    const r = checkHosts(a);
    assert.equal(r.ok, false, `api.${key}.host slipped through`);
    assert.ok(r.offenders.includes('evil.example.com'), `api.${key}.host not flagged`);
  }
});

test('the whole adapter is rejected, not merely reported on', () => {
  // checkHosts returning ok:false is no use if validateAdapter still calls the source fine — that is
  // what the loader and the catalogue's PR check actually run. Uses the real ing-es source so the
  // case cannot pass for some unrelated reason: unmodified it must validate, and the single edit
  // below must be enough to reject it. This is the audit finding, verbatim.
  const ing = JSON.parse(readFileSync(join(ROOT, 'sources-repo/sources/ing-es.json'), 'utf8'));
  assert.equal(validateAdapter(ing).ok, true, 'ing-es must validate as published');
  ing.streams[2].api.host = EVIL;
  assert.equal(validateAdapter(ing).ok, false, 'one foreign stream host must be enough to refuse it');
});

test('a stream host on the source’s own domain is still fine', () => {
  // ING's real shape: the monthly statement is served from the site host rather than the API host.
  const a = base();
  a.streams = [{ id: 'statement', api: { host: 'https://bank.es', pdf: { path: '/statement' } } }];
  const r = checkHosts(a);
  assert.equal(r.ok, true, `a same-domain stream host must still pass: ${JSON.stringify(r.offenders)}`);
});

test('a stream host on a declared crossDomainHosts entry still passes, with consent owed', () => {
  const a = base();
  a.crossDomainHosts = ['files.example.org'];
  a.streams = [{ id: 's', api: { host: 'https://files.example.org', pdf: { path: '/x' } } }];
  const r = checkHosts(a);
  assert.equal(r.ok, true);
  assert.ok(r.crossDomain.includes('example.org'), 'must still be flagged as off-site for consent');
});

test('every published source still passes — the walk must not invent hosts', () => {
  // Walking the graph for any key called "host" is fail-closed, but it could in principle catch a
  // field mapping or a piece of prose that happens to use that name. This is the check that it does
  // not: all real sources must survive it.
  const dir = join(ROOT, 'sources-repo/sources');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
  assert.ok(files.length >= 20, `expected the catalogue, found ${files.length}`);
  for (const f of files) {
    const a = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const r = checkHosts(a);
    assert.equal(r.ok, true, `${f} now rejected — offenders: ${JSON.stringify(r.offenders)}`);
  }
});
