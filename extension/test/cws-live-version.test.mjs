import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLiveVersion, compareToLive } from '../../scripts/cws-live-version.mjs';

// The build reported the Chrome Web Store's state from the upload API's return code alone, which says
// nothing about what users actually receive: a release sat "published" in the dashboard while the update
// service still served the previous version, and a 400 from the publish call read as a hard failure when
// it was not. This asks the service Chrome itself asks. Extension id below is the real public one — it is
// not a secret (it is in every install link).

const ok = (v) => `<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0" server="prod"><daystart elapsed_seconds="83593"/><app appid="abc" cohort="1::" status="ok"><updatecheck codebase="https://example.test/ABC_0_9_12_0.crx" size="711587" status="ok" version="${v}"/></app></gupdate>`;

test('the served version is read from the update-check response', () => {
  assert.equal(parseLiveVersion(ok('0.9.12')), '0.9.12');
  assert.equal(parseLiveVersion(ok('1.0.0')), '1.0.0');
});

test('a four-part dev version is read whole, not truncated', () => {
  assert.equal(parseLiveVersion(ok('0.9.16.2')), '0.9.16.2');
});

test('the protocol version is not mistaken for the extension version', () => {
  // The envelope carries protocol="2.0" and the app carries the real one; order in the document must not
  // decide the answer.
  const xml = parseLiveVersion(ok('0.9.12'));
  assert.equal(xml, '0.9.12');
  assert.notEqual(xml, '2.0');
});

test('an unknown or unpublished item yields nothing rather than a wrong version', () => {
  assert.equal(parseLiveVersion('<gupdate protocol="2.0"><app appid="abc" status="error-unknownApplication"/></gupdate>'), '');
  assert.equal(parseLiveVersion(''), '');
  assert.equal(parseLiveVersion(null), '');
  assert.equal(parseLiveVersion('not xml at all'), '');
});

// ---------------------------------------------------------------- the verdict

test('a store that is already serving the built version says so', () => {
  assert.deepEqual(compareToLive('0.9.16', '0.9.16'), { state: 'current', ok: true });
});

test('a store still on the previous version is propagating, not broken', () => {
  // Publishing marks the item; reaching the update servers takes a while. Reporting this as a failure is
  // what sent us chasing a permission problem that did not exist.
  const v = compareToLive('0.9.16', '0.9.12');
  assert.equal(v.state, 'propagating');
  assert.equal(v.ok, true, 'a lag behind the just-built version is expected, never a build failure');
});

test('a store ahead of this build is reported as such rather than as an error', () => {
  // Re-running an old tag's workflow: the store is correctly ahead.
  assert.equal(compareToLive('0.9.12', '0.9.16').state, 'ahead');
});

test('no answer from the update service is unknown, not zero', () => {
  const v = compareToLive('0.9.16', '');
  assert.equal(v.state, 'unknown');
  assert.equal(v.ok, true, 'the update service being unreachable must not fail a release');
});
