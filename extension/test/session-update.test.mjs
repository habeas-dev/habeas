// Record mode keeps its buffers (samples, assets, page texts…) in storage.session and updates them by
// read → modify → write. A page that loads three lists at once sends three samples together; unserialized,
// all three read the same array and the last write wins, so lists vanish from the recording — how many
// depends on the machine's speed. updateSession() queues the updates of one key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSessionUpdater } from '../src/lib/sessionupdate.js';

// An async storage area with latency, like chrome.storage.session.
function fakeArea() {
  const data = {};
  const later = (v) => new Promise((r) => setTimeout(() => r(v), 5));
  return {
    data,
    get: (k) => later({ [k]: data[k] }),
    set: (o) => later(Object.assign(data, JSON.parse(JSON.stringify(o)))),
  };
}

test('concurrent updates of one key are all kept', async () => {
  const area = fakeArea();
  const update = makeSessionUpdater(area);
  await Promise.all(['/a', '/b', '/c'].map((url) => update('samples:x', (arr = []) => [{ url }, ...arr])));
  assert.deepEqual(area.data['samples:x'].map((s) => s.url).sort(), ['/a', '/b', '/c']);
});

test('updates of different keys do not wait for each other, and a failing one does not block the next', async () => {
  const area = fakeArea();
  const update = makeSessionUpdater(area);
  await update('k', () => { throw new Error('boom'); }).catch(() => {});
  await Promise.all([update('k', (n = 0) => n + 1), update('k', (n = 0) => n + 1), update('j', () => 'other')]);
  assert.equal(area.data.k, 2);
  assert.equal(area.data.j, 'other');
});
