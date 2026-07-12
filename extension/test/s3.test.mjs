// S3 sink: PUTs each object (+ a cumulative per-source manifest) via SigV4. Mocks fetch and uses no
// secret (empty secretAccessKey still produces a valid Authorization header shape — the SigV4 algorithm
// itself is verified against AWS's vector in sigv4.test.mjs). Checks URL style, auth, and manifest merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeToSink } from '../src/sinks/sinks.js';

function mockS3() {
  const calls = [];
  const store = {};
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, auth: init.headers && init.headers.Authorization, cty: init.headers && init.headers['content-type'] });
    if (method === 'GET') return store[url] != null ? { ok: true, status: 200, json: async () => JSON.parse(store[url]) } : { ok: false, status: 404, text: async () => '' };
    store[url] = init.body ? Buffer.from(init.body).toString('utf8') : ''; // PUT
    return { ok: true, status: 200, text: async () => '' };
  };
  return { calls, store, restore: () => { delete globalThis.fetch; } };
}

test('s3: PUTs objects + a merged manifest with a SigV4 Authorization header (virtual-host URL)', async () => {
  const { calls, store, restore } = mockS3();
  const sink = { id: 's3', type: 's3', bucket: 'mybucket', region: 'eu-west-1', accessKeyId: 'AKIAEXAMPLE' };
  const mk = (id, date) => [{ internalId: id, date, total: 5, source: 'demo-es', type: 'receipt' }, new Map([[id, [{ blob: new Blob(['%PDF-1'], { type: 'application/pdf' }), ext: 'pdf' }]]])];

  const [d1, f1] = mk('A1', '2026-01-02');
  const res = await writeToSink(sink, [d1], f1, { service: 'documents', source: 'demo-es' });
  assert.equal(res.written, 1);

  const puts = calls.filter((c) => c.method === 'PUT');
  assert.ok(puts.length >= 2, 'object + manifest PUT');
  assert.ok(puts.every((c) => c.auth && c.auth.startsWith('AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/')), 'SigV4 auth on every PUT');
  assert.ok(puts.some((c) => c.url.startsWith('https://mybucket.s3.eu-west-1.amazonaws.com/')), 'virtual-host-style URL');

  const [d2, f2] = mk('A2', '2026-02-02');
  await writeToSink(sink, [d2], f2, { service: 'documents', source: 'demo-es' });
  const mfUrl = Object.keys(store).find((u) => u.endsWith('/documents/demo-es.json'));
  assert.equal(JSON.parse(store[mfUrl]).length, 2, 'manifest accumulates across runs');
  restore();
});

test('s3: a custom endpoint uses path-style URLs (MinIO/R2/B2)', async () => {
  const { calls, restore } = mockS3();
  const sink = { id: 's3', type: 's3', bucket: 'buck', region: 'us-east-1', accessKeyId: 'AK', endpoint: 'https://minio.example.com', pathStyle: true, prefix: 'habeas' };
  const [d, f] = [{ internalId: 'X1', date: '2026-01-02', total: 1, source: 's', type: 'receipt' }, new Map([['X1', [{ blob: new Blob(['x'], { type: 'application/pdf' }), ext: 'pdf' }]]])];
  await writeToSink(sink, [d], f, { service: 'documents', source: 's' });
  assert.ok(calls.some((c) => c.method === 'PUT' && c.url.startsWith('https://minio.example.com/buck/habeas/')), 'path-style + prefix');
  restore();
});

test('s3: missing bucket/accessKeyId throws', async () => {
  await assert.rejects(() => writeToSink({ id: 'x', type: 's3', region: 'us-east-1' }, [], new Map(), {}), /bucket \+ accessKeyId/);
});
