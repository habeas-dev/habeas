import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyNormalize, canonicalize } from '../src/lib/normalize.js';

const ING = { normalize: { counterparty: { from: 'description', flags: 'i', re: [
  '(?:enviad[oa] a|recibid[oa] de|a favor de|domiciliaci[oó]n de)\\s+(.+)$',
  '^N[oó]mina recibida\\s+(.+)$',
  '^Recibo\\s+(.+?)\\s*(?:·.*)?$',
] } } };

test('applyNormalize extracts counterparty from description (patterns tried in order)', () => {
  const cases = [
    ['Bizum enviado a MARIA ISABEL CARDENAL', 'MARIA ISABEL CARDENAL'],
    ['Bizum recibido de Juan Perez', 'Juan Perez'],
    ['Nomina recibida ELZABURU, SLP', 'ELZABURU, SLP'],
    ['Recibo PEPE ENERGY · Cuenta NÓMINA', 'PEPE ENERGY'],
    ['Compra en super', ''], // no pattern matches → left empty (never guess)
  ];
  for (const [desc, want] of cases) {
    const doc = { description: desc };
    applyNormalize(doc, ING);
    assert.equal(doc.counterparty || '', want, desc);
  }
});

test('applyNormalize never overrides an existing counterparty and tolerates bad patterns', () => {
  const doc = { description: 'Bizum enviado a X', counterparty: 'Already' };
  applyNormalize(doc, ING);
  assert.equal(doc.counterparty, 'Already');
  const d2 = { description: 'x' };
  applyNormalize(d2, { normalize: { counterparty: { from: 'description', re: '([' } } }); // invalid regex
  assert.equal(d2.counterparty, undefined);
});

test('canonicalize maps any schema to ONE uniform shape', () => {
  const tx = { internalId: 't1', date: '2026-07-11', amount: -20, currency: 'EUR', description: 'x', counterparty: 'Maria', category: 'transfer', type: 'TFRIPAY', account: 'ES11', direction: 'debit', number: undefined, source: 'ing-es', extra: { balance: 5 } };
  const c1 = canonicalize(tx);
  assert.equal(c1.id, 't1'); assert.equal(c1.amount, -20); assert.equal(c1.direction, 'debit');
  assert.equal(c1.counterparty, 'Maria'); assert.deepEqual(c1.extra, { balance: 5 });
  // a RECEIPT canonicalizes to the SAME shape (total→amount, store→counterparty, sign→direction)
  const rcpt = { internalId: 'r1', date: '2026-01-01', total: 12.5, currency: 'EUR', store: { name: 'Carrefour' }, category: 'grocery', type: 'HYPER', source: 'carrefour-es' };
  const c2 = canonicalize(rcpt);
  assert.equal(c2.amount, 12.5); assert.equal(c2.counterparty, 'Carrefour'); assert.equal(c2.direction, 'credit');
  assert.deepEqual(Object.keys(c1).filter((k) => k !== 'extra').sort(), Object.keys(c2).sort());
});
