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
  const v = compareToLive('0.9.16', '0.9.16');
  assert.equal(v.state, 'current');
  assert.equal(v.ok, true);
});

test('a store behind the build says only that, when nobody knows how long it has been', () => {
  // The old wording asserted "published, still reaching the update servers (normal, minutes to a few
  // hours)" whatever had happened — including for a version that was never uploaded at all, and for one
  // that had been stuck for days. Both were said out loud, and both were wrong.
  const v = compareToLive('0.9.17', '0.9.16');
  assert.equal(v.state, 'behind');
  assert.equal(v.ok, true, 'being behind is never a build failure');
  assert.ok(!/publish/i.test(v.note), `must not claim it was published: ${v.note}`);
  assert.ok(!/minutes|hours/i.test(v.note), `must not promise a timescale it cannot know: ${v.note}`);
});

test('with the age known and short, it is fair to call it propagation', () => {
  const v = compareToLive('0.9.17', '0.9.16', 3);
  assert.equal(v.state, 'behind');
  assert.equal(v.stale, false);
  assert.match(v.note, /propagat/i);
});

test('with the age known and long, it says plainly that this is no longer propagation', () => {
  // Three days is what actually happened, while the check kept calling it normal.
  const v = compareToLive('0.9.17', '0.9.16', 72);
  assert.equal(v.stale, true);
  assert.ok(!/normal/i.test(v.note), `stopped being normal two days ago: ${v.note}`);
  assert.match(v.note, /3d|72h|no longer|check/i);
  assert.equal(v.ok, true, 'still not a build failure — it is a prompt to go look');
});

test('the boundary is a day, so an overnight release is not called stuck', () => {
  assert.equal(compareToLive('0.9.17', '0.9.16', 23).stale, false);
  assert.equal(compareToLive('0.9.17', '0.9.16', 25).stale, true);
});

test('a store ahead of this build is reported as such rather than as an error', () => {
  // Re-running an old tag's workflow: the store is correctly ahead.
  const v = compareToLive('0.9.12', '0.9.16');
  assert.equal(v.state, 'ahead');
  assert.equal(v.ok, true);
});

test('no answer from the update service is unknown, not zero', () => {
  const v = compareToLive('0.9.16', '');
  assert.equal(v.state, 'unknown');
  assert.equal(v.ok, true, 'the update service being unreachable must not fail a release');
  assert.ok(!/propagat|publish/i.test(v.note), `unknown must not be dressed up as progress: ${v.note}`);
});

test('every verdict carries a note, since the note is what a human reads', () => {
  for (const args of [['1.0.0', '1.0.0'], ['1.0.1', '1.0.0'], ['1.0.1', '1.0.0', 99], ['1.0.0', '1.0.1'], ['1.0.0', '']]) {
    const v = compareToLive(...args);
    assert.ok(v.note && v.note.length > 10, `no note for ${JSON.stringify(args)}`);
  }
});
