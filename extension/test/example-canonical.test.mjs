// The canonical-record sample is linked publicly from the developers page, so it is a published contract,
// not a scratch file. It is generated from the real canonicalize(), and this guards the only way that can
// go wrong: the shape changes, nobody regenerates, and the sample quietly documents a format Habeas no
// longer produces. Both fixes to canonicalize that prompted the sample changed its output, which is
// exactly the drift this catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSample, serialize, SAMPLE_PATH } from '../../examples/canonical-record.mjs';

test('the published canonical-record sample matches what the code produces now', () => {
  const committed = readFileSync(SAMPLE_PATH, 'utf8');
  assert.equal(committed, serialize(buildSample()),
    'examples/canonical-record.json is stale — regenerate it with `node examples/canonical-record.mjs`');
});

test('the sample keeps demonstrating what it is there to demonstrate', () => {
  const rows = buildSample();
  // one uniform key set is the whole promise; only these four are conditional on what the source captured
  const optional = new Set(['valueDate', 'balanceAfter', 'extra', 'idStable']);
  const fixed = Object.keys(rows[0]).filter((k) => !optional.has(k)).sort();
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).filter((k) => !optional.has(k)).sort(), fixed, `record ${r.id}`);
  }
  // non-IBAN accounts must be present and must NOT have acquired an `iban`
  const us = rows.find((r) => r.id.startsWith('us-'));
  const gb = rows.find((r) => r.id.startsWith('gb-'));
  assert.equal(us.account.routingNumber, '021000021', 'an adapter-supplied account travels verbatim');
  assert.ok(!('iban' in us.account) && !('iban' in gb.account), 'no IBAN is invented for non-IBAN schemes');
  assert.equal(gb.account.last4, '5678');
  // currency is the source's, never coerced
  assert.deepEqual([...new Set(rows.map((r) => r.currency))].sort(), ['EUR', 'GBP', 'USD']);
  // the current account's running balance adds up, statement by statement
  const es = rows.filter((r) => r.account && r.account.iban && r.balanceAfter != null);
  for (let i = 1; i < es.length; i++) {
    assert.equal(Math.round((es[i - 1].balanceAfter + es[i].amount) * 100) / 100, es[i].balanceAfter,
      `balance chain breaks at ${es[i].id}`);
  }
});
