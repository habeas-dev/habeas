// A source may declare several STREAMS and, per stream, several FORMATS — so one source replaces several
// (e.g. WiZink: stream "movimientos" (transactions); stream "extractos" (statements) available as PDF or
// Excel). A STREAM is a data set (its own list + schema + fields); a FORMAT is an artifact representation
// that SHARES the stream's items (PDF vs Excel of the same statement) and only overrides the artifact.
// A selectable OUTPUT is a (stream, format) pair, id "stream/format". Each is a partial adapter merged over
// the shared base (auth, api.host, match, domain). A source with no `streams` is a single implicit output
// (fully backward-compatible). The user picks which outputs to obtain (default: all); a sink whose
// `accepts` matches only some outputs auto-selects those.

// Selectable outputs = every (stream, format) pair; a single implicit one when no streams are declared.
export function outputsOf(adapter) {
  const streams = adapter && adapter.streams;
  if (!streams || !streams.length) return [{ id: '', stream: '', format: '', name: (adapter && (adapter.name || adapter.id)) || '' }];
  const out = [];
  for (const s of streams) {
    const formats = (s.formats && s.formats.length) ? s.formats : [{ id: '', name: '' }];
    for (const f of formats) out.push({ id: s.id + (f.id ? '/' + f.id : ''), stream: s.id, format: f.id, name: (s.name || s.id) + (f.name ? ' · ' + f.name : '') });
  }
  return out;
}

// The effective adapter for one output id ("stream" or "stream/format"): base ⊕ stream ⊕ format.
export function resolveOutput(adapter, outputId) {
  if (!adapter || !adapter.streams || !adapter.streams.length) return adapter;
  const [sid, fid] = String(outputId || '').split('/');
  const s = adapter.streams.find((x) => x.id === sid) || adapter.streams[0];
  const f = (s.formats || []).find((x) => x.id === fid) || (s.formats || [])[0] || {};
  const eff = {
    ...adapter,
    api: { ...(adapter.api || {}), ...(s.api || {}), ...(f.api || {}) }, // stream.list, then format.pdf/artifact
    fields: { ...(adapter.fields || {}), ...(s.fields || {}), ...(f.fields || {}) },
    schema: f.schema || s.schema || adapter.schema,
    categories: f.categories || s.categories || adapter.categories,
    keepRaw: f.keepRaw ?? s.keepRaw ?? adapter.keepRaw, // preserve the raw list item under record.extra (per stream)
    _stream: s.id, _format: f.id || '', _output: s.id + (f.id ? '/' + f.id : ''),
    _outputName: (s.name || s.id) + (f.name ? ' · ' + f.name : ''),
  };
  delete eff.streams;
  return eff;
}

// Canonical-store / ledger key. Items live per STREAM (PDF and Excel of a statement are the SAME item — one
// record, two artifacts), so the store keys by source+stream; a bare source keeps its plain id.
export const storeKeyOf = (sourceId, streamId) => sourceId + (streamId ? ':' + streamId : '');

// Filter the outputs to those a sink accepts (auto-select for a typed consumer). `sinkAccepts` is the
// existing sinkAcceptsSource(sink, effectiveAdapter) predicate. Falls back to all if none match.
export function outputsForSink(adapter, sink, sinkAccepts) {
  const outs = outputsOf(adapter);
  if (!sink || !sinkAccepts) return outs;
  const ok = outs.filter((o) => sinkAccepts(sink, resolveOutput(adapter, o.id)));
  return ok.length ? ok : outs;
}
