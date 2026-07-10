// Invoice records optionally carry a human `description` (e.g. WiZink statements "Extracto <date>") so a
// row loaded from the store shows it instead of the opaque internalId — but stay byte-identical when absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord } from '../src/sinks/format.js';

const inv = { schema: 'invoice@1', currency: 'EUR' };

test('invoice record carries description when the doc provides one', () => {
  const r = buildRecord({ internalId: 'ACC|2026-06-23', date: '2026-06-23', description: 'Extracto 2026-06-23', type: 'Extracto' }, inv);
  assert.equal(r.description, 'Extracto 2026-06-23');
  assert.equal(r.type, 'Extracto');
});

test('a computed label alone does NOT populate description (kept explicit, records stay clean)', () => {
  const r = buildRecord({ internalId: 'x', date: '2026-06-23', label: 'Some issuer name' }, inv);
  assert.ok(!('description' in r));
});

test('invoice record omits description entirely when there is none (byte-identical to before)', () => {
  const r = buildRecord({ internalId: 'x', date: '2026-06-23' }, inv);
  assert.ok(!('description' in r), 'no empty description key added');
});
