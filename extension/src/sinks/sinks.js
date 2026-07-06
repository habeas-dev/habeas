// Sinks: pluggable outputs. A sink writes documents (+ their PDF blobs) somewhere the
// user controls. Persistent sinks (local-folder, drive) keep a CUMULATIVE per-service
// manifest (<service>/manifest.json) so repeated syncs merge instead of clobbering, and
// different providers never collide. The ephemeral download ZIP carries a snapshot.
import { getSecret } from '../lib/secrets.js';
import { makeZip } from '../lib/zip.js';
import { pathFor, buildManifest, toRecords, mergeRecords, jsonBlob, today } from './format.js';
import { driveWrite } from './drive.js';

export function listSinkTypes() { return ['download', 'local-folder', 'drive', 'http']; }

export async function writeToSink(sink, docs, files, opts = {}) {
  const impl = IMPL[sink.type];
  if (!impl) throw new Error('unknown sink type: ' + sink.type);
  return impl(sink, docs, files, opts);
}

const IMPL = {
  // Available PDFs + a <service>/manifest.json snapshot, bundled into one ZIP (the ZIP
  // only exists to dodge Chrome's multi-download block; other sinks write files directly).
  async download(sink, docs, files, opts) {
    const service = opts.service || 'documents';
    const entries = [];
    for (const d of docs) for (const art of files.get(d.internalId) || []) entries.push({ name: pathFor(sink, d, opts, art.ext), blob: art.blob });
    const written = entries.length;
    entries.push({ name: `${service}/manifest.json`, blob: jsonBlob(buildManifest(docs, files)) });
    const zip = await makeZip(entries);
    triggerDownload(zip, `habeas-${service}-${today()}.zip`);
    return { written, total: docs.length };
  },

  // Local folder via File System Access (point it at a synced folder for "cloud").
  async ['local-folder'](sink, docs, files, opts) {
    const root = opts.dirHandle;
    if (!root) throw new Error('no directory handle (elige carpeta)');
    const service = opts.service || 'documents';
    let n = 0;
    for (const d of docs) {
      for (const art of files.get(d.internalId) || []) {
        const rel = pathFor(sink, d, opts, art.ext).split('/');
        const dir = await ensureDir(root, rel.slice(0, -1));
        await writeFile(dir, rel.at(-1), art.blob); n++;
      }
    }
    const svcDir = await ensureDir(root, [service]);
    const existing = await readJsonFile(svcDir, 'manifest.json');
    const merged = mergeRecords(existing, toRecords(docs, files));
    await writeFile(svcDir, 'manifest.json', jsonBlob(JSON.stringify(merged, null, 2)));
    return { written: n, total: docs.length };
  },

  // Native Google Drive — individual uploads + cumulative manifest (see drive.js).
  drive: (sink, docs, files, opts) => driveWrite(sink, docs, files, opts),

  // HTTP consumer (Tiquetera / Cuéntamo): POST normalized records + available PDFs.
  async http(sink, docs, files, opts = {}) {
    const token = await getSecret(sink.tokenRef);
    const form = new FormData();
    // Tell the consumer WHICH source produced this data (e.g. "decathlon-es").
    if (opts.source) form.append('source', opts.source);
    if (opts.service) form.append('service', opts.service);
    form.append('records', buildManifest(docs, files));
    for (const d of docs) for (const art of files.get(d.internalId) || []) form.append('files[]', art.blob, d.internalId + '.' + art.ext);
    // sink.headers: caller-supplied (e.g. an externally-proposed sink's pairing token). tokenRef wins.
    const headers = { ...(sink.headers || {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) };
    const res = await fetch(sink.url, { method: 'POST', headers, body: form });
    if (!res.ok) throw new Error('http sink ' + res.status);
    return await res.json().catch(() => ({ written: docs.length, total: docs.length }));
  },
};

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}
async function ensureDir(root, parts) {
  let dir = root;
  for (const p of parts.filter(Boolean)) dir = await dir.getDirectoryHandle(p, { create: true });
  return dir;
}
async function writeFile(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(blob); await w.close();
}
async function readJsonFile(dir, name) {
  try { const fh = await dir.getFileHandle(name); return JSON.parse(await (await fh.getFile()).text()); }
  catch (e) { return []; }
}
