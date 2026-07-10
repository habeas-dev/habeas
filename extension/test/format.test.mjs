import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sinkAcceptsArtifact, sourceFormats, pathFor, mergeRecords } from '../src/sinks/format.js';

test('mergeRecords keeps the cumulative manifest oldest → newest', () => {
  const merged = mergeRecords(
    [{ internalId: 'a', date: '2026-01-05' }],
    [{ internalId: 'b', date: '2026-03-01' }, { internalId: 'c', date: '2026-02-01' }],
  );
  assert.deepEqual(merged.map((r) => r.internalId), ['a', 'c', 'b']);
});

test('pathFor puts a grouped doc under a top-level group folder (name + last4)', () => {
  const doc = { internalId: 'ACC1|2026-06-23', date: '2026-06-23', _group: { name: 'WiZink Oro', mask: '**** **** **** 8765' } };
  const p = pathFor({}, doc, { service: 'wizink' }, 'xls');
  assert.match(p, /^wizink\/WiZink Oro 8765\/2026\/2026-06-23-/); // service first, then group folder (name + last4)
  assert.ok(p.endsWith('.xls'));
  const flat = pathFor({}, { internalId: 'x', date: '2026-01-01' }, { service: 's' }, 'pdf'); // no group → no group folder
  assert.equal(flat, 's/2026/2026-01-01-x.pdf');
});

test('sinkAcceptsArtifact filters by artifact kind AND format (ext)', () => {
  const pdfOnly = { accepts: { formats: ['pdf'] } };
  assert.equal(sinkAcceptsArtifact(pdfOnly, { kind: 'document', ext: 'pdf' }), true);
  assert.equal(sinkAcceptsArtifact(pdfOnly, { kind: 'document', ext: 'xls' }), false); // wrong format
  assert.equal(sinkAcceptsArtifact({}, { kind: 'data', ext: 'json' }), true); // no accepts → anything
  const dataOnly = { accepts: { artifacts: ['data'] } };
  assert.equal(sinkAcceptsArtifact(dataOnly, { kind: 'document', ext: 'pdf' }), false); // wrong kind
  assert.equal(sinkAcceptsArtifact(dataOnly, 'data'), true); // bare-kind back-compat (no ext)
  const xlsOrCsv = { accepts: { formats: ['xls', 'csv'] } };
  assert.equal(sinkAcceptsArtifact(xlsOrCsv, { kind: 'document', ext: 'xls' }), true);
});

test('sourceFormats returns the distinct exts of the artifact kinds', () => {
  assert.deepEqual(sourceFormats([{ kind: 'data', ext: 'json' }, { kind: 'document', ext: 'pdf' }]), ['json', 'pdf']);
  assert.deepEqual(sourceFormats([{ kind: 'document', ext: 'xls' }]), ['xls']);
});
