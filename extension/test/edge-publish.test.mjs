import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOperation, BASE, headers } from '../../scripts/edge-publish.mjs';

// The Edge Add-ons API reports everything through an operation poll, and the difference between "still
// working", "already in review" and "genuinely broken" is only in that payload. Getting it wrong either
// fails a healthy release or hides a real failure, which is the exact trap the Chrome retry fell into.

test('an in-progress operation is neither done nor an error', () => {
  const v = classifyOperation({ status: 'InProgress' });
  assert.equal(v.done, false);
  assert.equal(v.ok, true);
});

test('a succeeded operation is done', () => {
  const v = classifyOperation({ status: 'Succeeded', message: 'Successfully created submission with ID 42' });
  assert.equal(v.done, true);
  assert.equal(v.ok, true);
});

test('"nothing new to publish" is not a failure — the store already has this build', () => {
  // Re-running a tag, or a retry after the store caught up. Failing the release for this would be noise.
  const v = classifyOperation({ status: 'Failed', errorCode: 'NoModulesUpdated', message: 'no updates' });
  assert.equal(v.done, true);
  assert.equal(v.ok, true);
  assert.match(v.note, /already/i);
});

test('"a submission is already in review" is not a failure either', () => {
  // The same state Chrome reports as ITEM_NOT_UPDATABLE: expected while the previous version is queued.
  const v = classifyOperation({ status: 'Failed', errorCode: 'InProgressSubmission', message: 'in progress' });
  assert.equal(v.done, true);
  assert.equal(v.ok, true);
  assert.match(v.note, /review/i);
});

test('a validation failure IS a failure, and carries its errors', () => {
  const v = classifyOperation({
    status: 'Failed', errorCode: 'SubmissionValidationError',
    message: 'submission validation failures', errors: ['key is not allowed', 'background.scripts'],
  });
  assert.equal(v.done, true);
  assert.equal(v.ok, false);
  assert.match(v.note, /key is not allowed/);
  assert.match(v.note, /background\.scripts/);
});

test('an unknown failure is reported rather than swallowed', () => {
  const v = classifyOperation({ status: 'Failed', message: 'An error occurred', errorCode: null });
  assert.equal(v.ok, false);
});

test('a malformed response is a failure, not a silent success', () => {
  // A publish path that silently does nothing is the failure mode this whole exercise exists to avoid.
  assert.equal(classifyOperation(null).ok, false);
  assert.equal(classifyOperation({}).ok, false);
});

test('the endpoint and auth headers match the documented v1.1 contract', () => {
  assert.equal(BASE, 'https://api.addons.microsoftedge.microsoft.com/v1');
  const h = headers('KEY', 'CID');
  assert.equal(h.Authorization, 'ApiKey KEY');
  assert.equal(h['X-ClientID'], 'CID');
});
