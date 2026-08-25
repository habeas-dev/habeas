// Copy documents whose only surviving file lives in a LOCAL FOLDER into another destination.
//
// The background handles every other origin (Dropbox, WebDAV, S3, Drive), but it cannot handle this
// one: a local-folder sink is reached through a File System Access directory handle, and only a page
// holds one — the service worker has no way to open it. So this runs page-side, from Settings, and is
// the second half of "copy my archive elsewhere".
//
// It exists for the same reason the whole feature does: many services refuse to hand over an old
// document twice (Carrefour answers 406 for old tickets, ING keeps about ninety days), so a file that
// only exists in one destination is a file that a change of destination would destroy.
//
// The delivery ledger is the cursor. Running this after the background pass is therefore free of
// double work: whatever the background already delivered is no longer pending.
import { getRecords, recordDelivered } from './store.js';
import { deliveredSet, markDelivered, rememberDocMeta } from './state.js';
import { retrieveDelivered } from './retrieve.js';
import { writeToSink } from '../sinks/sinks.js';
import { acceptsDoc } from '../sinks/format.js';
import { storeIdOf } from './instances.js';
import { storeKeyOf, outputsOf, resolveOutput } from './outputs.js';
import { artifactKinds, documentExt } from '../runtime/inventory.js';

const CHUNK = 25; // same checkpoint size the background uses: an interruption costs one chunk, not the run

// Which stored documents `target` still owes, for one source. Mirrors the background's pickStoredDocs,
// including the account allow-list — the archive holds every account ever collected, but a copy must
// only move the ones the user still has selected.
async function pending(ds, adapter, target) {
  const sid0 = storeIdOf(ds, adapter);
  const delivered = await deliveredSet(ds.id, target.id).catch(() => ({}));
  const allow = Array.isArray(ds.groupLabels) && ds.groupLabels.length ? new Set(ds.groupLabels.map(String)) : null;
  const out = [];
  for (const sid of [...new Set(outputsOf(adapter).map((o) => o.stream))]) {
    let recs; try { recs = await getRecords(storeKeyOf(sid0, sid), { delivered }); } catch (e) { continue; }
    for (const r of recs || []) {
      if (!r || r.internalId == null) continue;
      const grp = String(r.group || '');
      if (allow && grp && !allow.has(grp)) continue;
      out.push({ internalId: r.internalId, record: r, stream: sid });
    }
  }
  return out;
}

/**
 * Move what `source` (a local-folder sink) holds into `target`, for every enabled source.
 * Never contacts a service: a document with no file in the folder is left pending, not fetched.
 * Returns { sent, found, skipped, stopped }.
 */
export async function copyFolderBackedDocs(cfg, adapters, source, target, { signal, onStatus } = {}) {
  let sent = 0, found = 0, skipped = 0;
  for (const ds of (cfg.datasources || [])) {
    if (signal && signal.aborted) break;
    if (ds.enabled === false) continue;
    const adapter = adapters[ds.adapter];
    if (!adapter) continue;
    const picked = await pending(ds, adapter, target).catch(() => []);
    if (!picked.length) continue;

    const byStream = new Map();
    for (const d of picked) { const s = d.stream || ''; if (!byStream.has(s)) byStream.set(s, []); byStream.get(s).push(d); }

    for (const [sid, list] of byStream) {
      if (signal && signal.aborted) break;
      const eff = resolveOutput(adapter, sid);
      const sk = storeKeyOf(storeIdOf(ds, adapter), sid);
      const fmts = outputsOf(adapter).filter((o) => o.stream === sid).map((o) => o.format);
      const docs = list.map((d) => {
        const rec = d.record || {};
        // category must sit on the doc itself — acceptsDoc reads doc.category, not record.category.
        const category = rec.category != null ? rec.category
          : ((adapter.categorize && adapter.categorize.default) || (adapter.categories && adapter.categories[0]));
        return { internalId: d.internalId, record: rec, date: rec.date, total: rec.total ?? rec.amount, currency: rec.currency,
                 category, type: rec.type, group: rec.group || '', _stream: sid, _storeKey: sk, _fromStore: true };
      }).filter((d) => acceptsDoc(target, d));
      if (!docs.length) continue;
      found += docs.length;

      const files = new Map();
      let batch = [];
      const flush = async () => {
        if (!batch.length) return;
        const b = batch; batch = [];
        if (onStatus) onStatus({ sending: b.length, sink: target.name || target.id });
        const res = await writeToSink(target, b, files, { service: adapter.service || ds.adapter, source: sk, ext: documentExt(eff) || 'pdf', interactive: true });
        // A destination that answers with per-record `accepted` decides what enters the ledger; one that
        // does not is taken at its word for the whole batch, exactly as the background does.
        const ok = Array.isArray(res && res.accepted) ? b.filter((d) => res.accepted.includes(d.internalId)) : b;
        await markDelivered(ds.id, target.id, ok.map((d) => d.internalId));
        try { await recordDelivered(sk, b, { source: adapter.id, schema: eff.schema, srcVersion: adapter.version }); } catch (e) {}
        try { await rememberDocMeta(storeIdOf(ds, adapter), b.map((d) => ({ internalId: d.internalId, exts: [...new Set((files.get(d.internalId) || []).map((a) => a && a.ext).filter(Boolean))] }))); } catch (e) {}
        for (const d of b) files.delete(d.internalId); // bound memory over a long run
        sent += ok.length;
      };

      for (const d of docs) {
        if (signal && signal.aborted) break;
        const arts = [];
        for (const fmt of (fmts.length ? fmts : [''])) {
          const oeff = resolveOutput(adapter, sid + (fmt ? '/' + fmt : ''));
          for (const kind of artifactKinds(oeff, d)) {
            const r = await retrieveDelivered(source, adapter, { ...d.record, internalId: d.internalId, date: d.date, group: d.group }, kind, { only: true }).catch(() => null);
            if (r && r.blob) arts.push({ blob: r.blob, ext: r.ext || kind });
          }
        }
        // No file in the folder → leave it pending rather than reaching for the service. The caller
        // reports these; silently fetching them would contradict what the operation promises.
        if (!arts.length) { skipped++; continue; }
        files.set(d.internalId, arts);
        batch.push(d);
        if (batch.length >= CHUNK) await flush();
      }
      await flush();
    }
  }
  return { sent, found, skipped, stopped: !!(signal && signal.aborted) };
}
