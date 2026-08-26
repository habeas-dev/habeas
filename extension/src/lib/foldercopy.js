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
import { retrieveDelivered, RETRIEVABLE } from './retrieve.js';
import { getHandle, verifyPermission } from './fs.js';
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
 * Copy an archive into `target`, page-side, for every enabled source.
 *
 * Runs here rather than in the background because a local folder is reachable only through a File System
 * Access directory handle, and only a page can hold one — the service worker resolves the handle from
 * IndexedDB but cannot be relied on to use it, which the codebase already hedges against elsewhere. That
 * applies whichever END the folder is: as the ORIGIN it must be read here, and as the TARGET it must be
 * written here. Missing the second case is what made a Dropbox→folder copy appear to run and produce
 * nothing at all: writeToSink threw "no directory handle" for every chunk, once per source, and the
 * failures were counted rather than shown.
 *
 * @param originId  pin the copy to one destination, or '' to take each file from wherever it is
 * @returns { sent, found, skipped, stopped }
 */
export async function copyArchivePageSide(cfg, adapters, target, { originId = '', signal, onStatus } = {}) {
  // Reading is fine from any retrievable destination; the TARGET is never one of them.
  const origins = (cfg.sinks || []).filter((s) => RETRIEVABLE.has(s.type) && s.id !== target.id
    && (!originId || s.id === originId));
  if (!origins.length) return { sent: 0, found: 0, skipped: 0, stopped: false };

  // Resolved once, and up front: if the folder is no longer authorised, asking now — inside the click
  // that started the copy — is the only moment a browser will grant it. Failing here beats failing after
  // twenty minutes of reading.
  let dirHandle;
  if (target.type === 'local-folder') {
    dirHandle = await getHandle('dir:' + target.id).catch(() => null);
    if (!dirHandle || !(await verifyPermission(dirHandle).catch(() => false))) {
      throw new Error('no directory handle');
    }
  }

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
        const res = await writeToSink(target, b, files, { service: adapter.service || ds.adapter, source: sk,
          ext: documentExt(eff) || 'pdf', interactive: true, dirHandle });
        // A destination answering with per-record `accepted` decides what enters the ledger; one that does
        // not is taken at its word for the whole batch, exactly as the background does.
        const ok = Array.isArray(res && res.accepted) ? b.filter((d) => res.accepted.includes(d.internalId)) : b;
        await markDelivered(ds.id, target.id, ok.map((d) => d.internalId));
        try { await recordDelivered(sk, b, { source: adapter.id, schema: eff.schema, srcVersion: adapter.version }); } catch (e) {}
        try { await rememberDocMeta(storeIdOf(ds, adapter), b.map((d) => ({ internalId: d.internalId, exts: [...new Set((files.get(d.internalId) || []).map((a) => a && a.ext).filter(Boolean))] }))); } catch (e) {}
        for (const d of b) files.delete(d.internalId); // bound memory over a long run
        sent += ok.length;
      };

      let seen = 0;
      for (const d of docs) {
        if (signal && signal.aborted) break;
        // Per DOCUMENT, not per flushed batch. Reporting only on flush meant nothing moved on screen for
        // the first 25 documents — each of which costs a round-trip to the origin — and nothing moved AT
        // ALL for an archive of record-only movements, where no batch ever fills because there is no file
        // to put in one. A silent operation is indistinguishable from a stuck one.
        if (onStatus) onStatus({ done: ++seen, total: docs.length, source: adapter.name || ds.adapter, skipped });
        const rec = { ...d.record, internalId: d.internalId, date: d.date, group: d.group };
        const arts = [];
        for (const fmt of (fmts.length ? fmts : [''])) {
          const oeff = resolveOutput(adapter, sid + (fmt ? '/' + fmt : ''));
          for (const kind of artifactKinds(oeff, d)) {
            for (const from of origins) {
              const r = await retrieveDelivered(from, adapter, rec, kind, { only: true }).catch(() => null);
              if (r && r.blob) { arts.push({ blob: r.blob, ext: r.ext || kind }); break; }
            }
          }
        }
        // Nowhere readable has the file → leave it pending rather than reach for the service. The caller
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
