// Source outputs: streams × formats (see lib/outputs.js). One source (WiZink) exposes movements +
// statements-as-PDF + statements-as-Excel; each (stream, format) resolves to an effective adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputsOf, resolveOutput, storeKeyOf, outputsForSink } from '../src/lib/outputs.js';

const WIZINK = {
  id: 'wizink-es', name: 'WiZink', domain: 'wizink.es',
  auth: { mode: 'cookie', replayHeaders: [] },
  api: { host: 'https://www.wizink.es' },
  streams: [
    { id: 'movimientos', name: 'Movimientos', schema: 'transaction@1', categories: ['card'],
      api: { list: { path: '/mov', paging: 'none' } }, fields: { internalId: 'id', amount: 'amount' } },
    { id: 'extractos', name: 'Extractos', schema: 'invoice@1', categories: ['card'],
      api: { list: { path: '/ext', paging: 'none' } }, fields: { internalId: 'id', total: 'total' },
      formats: [
        { id: 'pdf', name: 'PDF', api: { pdf: { path: '/ext/{internalId}/pdf', ext: 'pdf' } } },
        { id: 'excel', name: 'Excel', api: { pdf: { path: '/ext/{internalId}/xls', ext: 'xls' } } },
      ] },
  ],
};

test('outputsOf: every (stream, format) pair; implicit single output when no streams', () => {
  assert.deepEqual(outputsOf(WIZINK).map((o) => o.id), ['movimientos', 'extractos/pdf', 'extractos/excel']);
  assert.deepEqual(outputsOf({ id: 'x', name: 'X' }).map((o) => o.id), ['']); // bare source → one implicit output
});

test('resolveOutput: base ⊕ stream ⊕ format', () => {
  const mov = resolveOutput(WIZINK, 'movimientos');
  assert.equal(mov.api.host, 'https://www.wizink.es'); // base kept
  assert.equal(mov.api.list.path, '/mov');             // stream list
  assert.equal(mov.schema, 'transaction@1');
  assert.equal(mov._output, 'movimientos');

  const pdf = resolveOutput(WIZINK, 'extractos/pdf');
  assert.equal(pdf.api.list.path, '/ext');             // stream list shared
  assert.equal(pdf.api.pdf.ext, 'pdf');                // format artifact
  assert.equal(pdf.schema, 'invoice@1');

  const xls = resolveOutput(WIZINK, 'extractos/excel');
  assert.equal(xls.api.list.path, '/ext');             // SAME statements list as pdf
  assert.equal(xls.api.pdf.ext, 'xls');                // only the artifact differs
});

test('resolveOutput: a source without streams is returned unchanged', () => {
  const a = { id: 'carrefour-es', api: { host: 'h', list: { path: '/l' } }, schema: 'receipt@1' };
  assert.equal(resolveOutput(a, ''), a);
});

test('storeKeyOf: keyed by stream (formats share items), plain id for a bare source', () => {
  assert.equal(storeKeyOf('wizink-es', 'extractos'), 'wizink-es:extractos');
  assert.equal(storeKeyOf('carrefour-es', ''), 'carrefour-es');
});

test('outputsForSink: auto-select the outputs a typed consumer accepts', () => {
  // a sink that only accepts transaction schema → only the movimientos output
  const accepts = (sink, eff) => eff.schema === sink.schemaWanted;
  const sink = { schemaWanted: 'transaction@1' };
  assert.deepEqual(outputsForSink(WIZINK, sink, accepts).map((o) => o.id), ['movimientos']);
  // a sink accepting nothing specific → all outputs (fallback)
  assert.equal(outputsForSink(WIZINK, { schemaWanted: 'nope' }, accepts).length, 3);
});
