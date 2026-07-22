import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sinkAcceptsArtifact, sourceFormats, pathFor, mergeRecords, adoptDetailMeta, bakeLearned, acceptsDoc } from '../src/sinks/format.js';

// acceptsDoc reads doc.category (top-level). A doc built from the store MUST copy category up from its record,
// or a sink with an accepts.categories filter rejects every stored doc → "nothing sent".
test('acceptsDoc uses the doc top-level category, not record.category', () => {
  const sink = { accepts: { categories: ['grocery'] } };
  assert.equal(acceptsDoc(sink, { category: 'grocery' }), true);
  assert.equal(acceptsDoc(sink, { category: 'fuel' }), false);
  assert.equal(acceptsDoc(sink, { record: { category: 'grocery' } }), false, 'category on record alone is not seen');
  assert.equal(acceptsDoc({}, {}), true, 'a sink with no filter accepts anything');
});

// A source whose list only exposes a year (Amazon) → the real date rides a JSON detail fetched at download time.
// adoptDetailMeta must pull it onto the doc + its record so the store gets the real date, not "YYYY-01-01".
const jsonArt = (o) => ({ ext: 'json', blob: { text: async () => JSON.stringify(o) } });

test('adoptDetailMeta pulls the real date/amount from the JSON detail over a year-only value', async () => {
  const d = { date: '2026', record: { date: '2026-01-01', total: 0 } };
  await adoptDetailMeta(d, [{ ext: 'pdf', blob: {} }, jsonArt({ date: '2026-06-14', total: 48.2, returnStatus: 'returned' })]);
  assert.equal(d.date, '2026-06-14');
  assert.equal(d.record.date, '2026-06-14');
  assert.equal(d.record.total, 48.2);
  assert.equal(d.record.returnStatus, 'returned');
  assert.equal(bakeLearned(d).date, '2026-06-14', 'the baked record carries the real date to the store');
});

test('adoptDetailMeta ignores a detail with only a year, and is a no-op with no JSON detail', async () => {
  const a = { date: '2026-01-01', record: { date: '2026-01-01' } };
  await adoptDetailMeta(a, [jsonArt({ date: '2026' })]); // year-only detail → not adopted
  assert.equal(a.record.date, '2026-01-01');
  const b = { date: '2026-01-01', record: { date: '2026-01-01' } };
  await adoptDetailMeta(b, [{ ext: 'pdf', blob: {} }]); // no JSON at all
  assert.equal(b.record.date, '2026-01-01');
});

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
