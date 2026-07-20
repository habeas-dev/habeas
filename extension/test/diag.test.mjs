// The failure diagnostic accumulates a structured entry PER failed request (not a single overwritten
// error), and renders it so "Report a problem" tells the team which request failed. All values synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LOCAL = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => (k in LOCAL ? { [k]: LOCAL[k] } : {}),
  set: async (o) => { Object.assign(LOCAL, o); },
  remove: async (k) => { delete LOCAL[k]; },
} } };
const { pushDiag, readDiag, clearDiag, formatDiag, recordingNet } = await import('../src/lib/diag.js');

test('pushDiag accumulates multiple failures (does not overwrite) and clearDiag removes them', async () => {
  for (const k of Object.keys(LOCAL)) delete LOCAL[k];
  await pushDiag('feci', { phase: 'document', output: 'extractos', item: '01/09/2025', message: 'statement 500', status: 500 });
  await pushDiag('feci', { phase: 'document', output: 'extractos', item: '01/08/2025', message: 'statement 500', status: 500 });
  const d = await readDiag('feci');
  assert.equal(d.entries.length, 2, 'both failures are kept, not just the first/last');
  assert.equal(d.entries[0].item, '01/09/2025');
  assert.equal(d.entries[1].item, '01/08/2025');
  await clearDiag('feci');
  assert.equal(await readDiag('feci'), null);
});

test('formatDiag renders which request failed (output, item, HTTP status, method + url)', () => {
  const txt = formatDiag({ entries: [
    { phase: 'document', output: 'extractos', kind: 'document', item: '01/09/2025', message: 'statement 500 internal error', status: 500, method: 'POST', url: 'https://x.test/dashboard/.../generate-file?datePurchase=01/09/2025' },
  ] });
  assert.match(txt, /output=extractos/);
  assert.match(txt, /item=01\/09\/2025/);
  assert.match(txt, /HTTP 500/);
  assert.match(txt, /POST https:\/\/x\.test\/dashboard/);
});

test('formatDiag is back-compatible with the old single-error shape, and empty is blank', () => {
  assert.equal(formatDiag({ error: 'groups 401 [sent: accept]', at: 'x' }), 'groups 401 [sent: accept]');
  assert.equal(formatDiag(null), '');
  assert.equal(formatDiag({ entries: [] }), '');
});

test('recordingNet remembers the LAST request issued (which one failed in a multi-step fetch)', async () => {
  const net = async (u) => ({ status: /generate-file/.test(u) ? 500 : 200, ok: !/generate-file/.test(u) });
  const rec = recordingNet(net);
  await rec.net('https://x.test/list', { method: 'GET' });
  await rec.net('https://x.test/generate-file', { method: 'POST' });
  assert.equal(rec.ref.last.method, 'POST');
  assert.equal(rec.ref.last.url, 'https://x.test/generate-file');
  assert.equal(rec.ref.last.status, 500);
});
