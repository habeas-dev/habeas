import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sinkAcceptsArtifact, sourceFormats } from '../src/sinks/format.js';

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
