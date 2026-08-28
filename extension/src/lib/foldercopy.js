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
import { deliveredSet, markDelivered, rememberDocMeta, getDocMeta } from './state.js';
import { retrieveDelivered, RETRIEVABLE } from './retrieve.js';
import { driveCache } from '../sinks/drive.js';
import { dropboxCache } from '../sinks/dropbox.js';
import { getHandle, verifyPermission } from './fs.js';
import { writeToSink } from '../sinks/sinks.js';
import { acceptsDoc, sinkAcceptsArtifact } from '../sinks/format.js';
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
  // One listing per origin folder for the whole copy, instead of a lookup (Drive) or a full download
  // (Dropbox) per document — a long copy is exactly where that difference decides whether it finishes.
  const caches = { driveCache: driveCache(), dropboxCache: dropboxCache() };

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
  // retrieveDelivered already reports the paths it looked under when it finds nothing, and throwing that
  // away is what made "zero bytes written" unanswerable: a document with no file and a document whose
  // file is filed somewhere else look identical from here. A handful of examples is enough to tell them
  // apart — if the paths look right, the files are genuinely absent; if they look wrong, the delivery
  // path and the retrieval path disagree, which is a bug rather than an empty archive.
  const misses = [];
  // Report BEFORE reading, not only once documents appear. Reading one source's records means fetching
  // them from wherever the archive lives — over the network, for a Dropbox-backed store — and a source
  // with nothing outstanding then reports nothing at all. With two dozen sources that is minutes of a
  // frozen message before the first document is even reached, which reads exactly like a hang.
  const enabled = (cfg.datasources || []).filter((d) => d.enabled !== false && adapters[d.adapter]);
  let n = 0;
  for (const ds of enabled) {
    if (signal && signal.aborted) break;
    const adapter = adapters[ds.adapter];
    n++;
    if (onStatus) onStatus({ phase: 'reading', source: adapter.name || ds.adapter, n, of: enabled.length });
    const picked = await pending(ds, adapter, target).catch(() => []);
    if (!picked.length) continue;
    // What Habeas already KNOWS each document has. Recorded at delivery time and by the Archive's format
    // scan, and consulted by the Archive, the popup and the viewer — but not, until now, by this. Probing
    // instead meant a request per document per candidate format, to rediscover something already written
    // down: a bank movement has no file, and asking a server to confirm that, once per movement, is how a
    // copy spends five minutes doing nothing visible.
    const known = await getDocMeta(storeIdOf(ds, adapter)).catch(() => ({}));

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

      // Can this STREAM produce an artifact at all? Adapter-level and free — no metadata, no requests, and
      // it works on an archive that predates the per-document records, which is the case that matters.
      // A bank movements stream declares none: its data rides the MANIFEST, which every writer emits
      // alongside the files. So a stream with no artifacts is not skipped — that would leave a bank
      // archive uncopied, which is most of what people have — it is delivered straight to batches with
      // nothing fetched at all.
      const streamKinds = (fmts.length ? fmts : ['']).flatMap((fmt) =>
        artifactKinds(resolveOutput(adapter, sid + (fmt ? '/' + fmt : ''))).filter((k) => sinkAcceptsArtifact(target, k)));
      const recordsOnly = !streamKinds.length;

      // Documents recorded as having no file are settled the same way: their records still travel, they
      // are simply not searched for.
      const hasNoFile = (d) => { const e = known[d.internalId] && known[d.internalId].exts; return Array.isArray(e) && !e.length; };
      const withFiles = recordsOnly ? [] : docs.filter((d) => !hasNoFile(d));
      const recordOnlyDocs = recordsOnly ? docs : docs.filter(hasNoFile);
      if (onStatus) {
        onStatus(recordsOnly
          ? { phase: 'records', source: adapter.name || ds.adapter, total: docs.length, n, of: enabled.length }
          : { phase: 'copying', done: 0, total: withFiles.length, source: adapter.name || ds.adapter, skipped, n, of: enabled.length });
      }

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

      // Records with no file to wait for go first, in batches, without a single request.
      let batchRO = [];
      for (const d of recordOnlyDocs) {
        if (signal && signal.aborted) break;
        batchRO.push(d);
        if (batchRO.length >= CHUNK) { batch = batchRO; batchRO = []; await flush(); }
      }
      if (batchRO.length) { batch = batchRO; await flush(); }

      let seen = 0;
      for (const d of withFiles) {
        if (signal && signal.aborted) break;
        // Per DOCUMENT, not per flushed batch. Reporting only on flush meant nothing moved on screen for
        // the first 25 documents — each of which costs a round-trip to the origin — and nothing moved AT
        // ALL for an archive of record-only movements, where no batch ever fills because there is no file
        // to put in one. A silent operation is indistinguishable from a stuck one.
        if (onStatus) onStatus({ phase: 'copying', done: ++seen, total: withFiles.length, source: adapter.name || ds.adapter, skipped, n, of: enabled.length });
        const rec = { ...d.record, internalId: d.internalId, date: d.date, group: d.group };
        // exts is authoritative when present: an empty list means "this has no file", which is a fact, not
        // something to go and check. Absent means nobody has looked yet, and only then is probing right.
        const ex = known[d.internalId] && known[d.internalId].exts;
        const wanted = Array.isArray(ex) && ex.length ? new Set(ex.map((x) => String(x).toLowerCase())) : null;
        const arts = [];
        for (const fmt of (fmts.length ? fmts : [''])) {
          const oeff = resolveOutput(adapter, sid + (fmt ? '/' + fmt : ''));
          // artifactKinds returns {kind, ext} objects, as the background has always treated them. Passing
          // the object where an extension belongs put "[object Object]" in every reconstructed path and
          // made the `only` filter compare an object against a string — so no file could EVER be found.
          // That, not the archive's contents, is why this wrote zero bytes.
          const kinds = artifactKinds(oeff).filter((k) => sinkAcceptsArtifact(target, k));
          const avail = artifactKinds(oeff, d); // per-doc: an item that lacks this kind
          for (const k of kinds) {
            if (!avail.some((a) => a.kind === k.kind)) continue;
            if (wanted && !wanted.has(String(k.ext).toLowerCase())) continue; // recorded as not existing
            for (const from of origins) {
              const r = await retrieveDelivered(from, adapter, rec, k.ext, { only: true, ...caches }).catch(() => null);
              if (r && r.blob) { arts.push({ blob: r.blob, ext: r.ext || k.ext }); break; }
              if (misses.length < 5 && r && Array.isArray(r.tried) && r.tried.length) {
                misses.push({ sink: from.name || from.id, source: adapter.id, id: d.internalId, tried: r.tried.slice(0, 2) });
              }
            }
          }
        }
        // Nowhere readable has the file. The RECORD still travels — dropping it would lose the data too,
        // for a document that at least exists — but the service is never contacted for the file, which is
        // what this operation promises. Counted so the shortfall is visible.
        if (!arts.length) skipped++;
        else files.set(d.internalId, arts);
        batch.push(d);
        if (batch.length >= CHUNK) await flush();
      }
      await flush();
    }
  }
  return { sent, found, skipped, misses, stopped: !!(signal && signal.aborted) };
}
