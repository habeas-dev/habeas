// Email sink: one email PER BATCH, files attached, via a provider's HTTP API using the user's own key.
// Stubs chrome (for the encrypted-secrets read, exercised via a legacy-plaintext value) + fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = { storage: { local: {
  get: async () => ({ 'habeas:secrets': { mailer: 'KEY123' } }), // legacy-plaintext secret → getSecret returns it
  set: async () => {},
} } };
const { writeToSink } = await import('../src/sinks/sinks.js');

function mockFetch() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: 'sent' }), text: async () => '' }; };
  return { calls, restore: () => { delete globalThis.fetch; } };
}
// docs + a files Map (internalId → [{blob, ext}]), the sink contract.
const batch = () => {
  const docs = [
    { internalId: 'S1', date: '2026-06-30', total: 12.5, currency: 'EUR', description: 'Extracto 2026-06', source: 'ing-es', type: 'invoice' },
    { internalId: 'S2', date: '2026-05-31', total: 9, currency: 'EUR', description: 'Extracto 2026-05', source: 'ing-es', type: 'invoice' },
  ];
  const files = new Map([
    ['S1', [{ blob: new Blob(['%PDF-1 uno'], { type: 'application/pdf' }), ext: 'pdf' }]],
    ['S2', [{ blob: new Blob(['%PDF-1 dos'], { type: 'application/pdf' }), ext: 'pdf' }]],
  ]);
  return { docs, files };
};

test('email (resend): ONE request per batch, both files + a manifest attached', async () => {
  const { calls, restore } = mockFetch();
  const sink = { id: 'mailer', type: 'email', provider: 'resend', from: 'me@ex.com', to: 'a@b.com, c@d.com', apiKeyRef: 'secret://mailer' };
  const { docs, files } = batch();
  const res = await writeToSink(sink, docs, files, { service: 'documents', source: 'ing-es' });

  assert.equal(res.written, 2);        // two PDFs
  assert.equal(calls.length, 1);        // ONE email for the whole batch
  const c = calls[0];
  assert.equal(c.url, 'https://api.resend.com/emails');
  assert.equal(c.init.headers.authorization, 'Bearer KEY123');
  const body = JSON.parse(c.init.body);
  assert.deepEqual(body.to, ['a@b.com', 'c@d.com']); // comma list → array
  assert.equal(body.from, 'me@ex.com');
  assert.equal(body.attachments.length, 3);          // 2 PDFs + manifest.json
  assert.ok(body.attachments.some((a) => a.filename === 'ing-es.json'));
  assert.ok(body.attachments.every((a) => typeof a.content === 'string' && a.content.length)); // base64 present
  restore();
});

test('email (postmark): maps to Postmark shape + token header', async () => {
  const { calls, restore } = mockFetch();
  const sink = { id: 'mailer', type: 'email', provider: 'postmark', from: 'me@ex.com', to: 'a@b.com', apiKeyRef: 'secret://mailer' };
  const { docs, files } = batch();
  await writeToSink(sink, docs, files, { service: 'documents', source: 'ing-es' });
  const c = calls[0];
  assert.equal(c.url, 'https://api.postmarkapp.com/email');
  assert.equal(c.init.headers['x-postmark-server-token'], 'KEY123');
  const body = JSON.parse(c.init.body);
  assert.equal(body.From, 'me@ex.com');
  assert.equal(body.To, 'a@b.com');
  assert.equal(body.Attachments.length, 3);
  assert.ok(body.Attachments.every((a) => a.Name && a.Content && a.ContentType));
  restore();
});

test('email: refuses to send with no recipient', async () => {
  const { restore } = mockFetch();
  const sink = { id: 'mailer', type: 'email', provider: 'resend', from: 'me@ex.com', to: '', apiKeyRef: 'secret://mailer' };
  const { docs, files } = batch();
  await assert.rejects(() => writeToSink(sink, docs, files, { service: 'documents', source: 'ing-es' }), /recipient/);
  restore();
});
