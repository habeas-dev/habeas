// Sinks: pluggable outputs. A sink writes documents (+ their PDF blobs) somewhere the
// user controls. Every sink also emits a manifest.json with the normalized records for
// ALL selected documents — including those whose PDF Carrefour no longer retains (old
// tickets), so their metadata (date, amount, store) is never lost.
import { getSecret } from '../lib/secrets.js';
import { renderPath } from '../lib/naming.js';
import { makeZip } from '../lib/zip.js';

export function listSinkTypes() { return ['download', 'local-folder', 'drive', 'http']; }

export async function writeToSink(sink, docs, files, opts = {}) {
  const impl = IMPL[sink.type];
  if (!impl) throw new Error('unknown sink type: ' + sink.type);
  return impl(sink, docs, files, opts);
}

const IMPL = {
  // Available PDFs + a manifest.json of ALL selected docs, bundled into one ZIP.
  async download(sink, docs, files, opts) {
    const present = docs.filter((d) => files.get(d.externalId));
    const entries = present.map((d) => ({ name: pathFor(sink, d, opts), blob: files.get(d.externalId) }));
    entries.push({ name: 'manifest.json', blob: jsonBlob(buildManifest(docs, files)) });
    const zip = await makeZip(entries);
    triggerDownload(zip, `habeas-${opts.service || 'docs'}-${today()}.zip`);
    return { written: present.length, total: docs.length };
  },

  // Local folder via File System Access (point it at a synced folder for "cloud").
  async ['local-folder'](sink, docs, files, opts) {
    const root = opts.dirHandle;
    if (!root) throw new Error('no directory handle (elige carpeta)');
    let n = 0;
    for (const d of docs) {
      const blob = files.get(d.externalId); if (!blob) continue;
      const rel = pathFor(sink, d, opts).split('/');
      const dir = await ensureDir(root, rel.slice(0, -1));
      await writeFile(dir, rel.at(-1), blob); n++;
    }
    await writeFile(root, 'manifest.json', jsonBlob(buildManifest(docs, files)));
    return { written: n, total: docs.length };
  },

  // Native Google Drive — pending the project's own OAuth client (scope drive.file).
  async drive() {
    throw new Error('Sink Drive nativo: pendiente del client OAuth (scope drive.file). Ver spec §6.9.');
  },

  // HTTP consumer (Tiquetera / Cuéntamo): POST normalized records + available PDFs.
  async http(sink, docs, files) {
    const token = await getSecret(sink.tokenRef);
    const form = new FormData();
    form.append('records', buildManifest(docs, files));
    for (const d of docs) { const b = files.get(d.externalId); if (b) form.append('files[]', b, d.externalId + '.pdf'); }
    const res = await fetch(sink.url, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: form });
    if (!res.ok) throw new Error('http sink ' + res.status);
    return await res.json().catch(() => ({ written: docs.length, total: docs.length }));
  },
};

function buildManifest(docs, files) {
  return JSON.stringify(docs.map((d) => ({ ...toRecord(d), pdf: files.has(d.externalId) })), null, 2);
}
function toRecord(d) {
  return { externalId: d.externalId, date: d.date, total: d.total, currency: 'EUR', store: { name: d.storeName, address: d.storeAddress }, source: d.source, type: d.type };
}
function pathFor(sink, d, opts) {
  const tpl = sink.pathTemplate || '{service}/{yyyy}/{date}-{externalId}.pdf';
  return renderPath(tpl, { service: opts.service || 'documents', date: (d.date || '').slice(0, 10), externalId: d.externalId, ext: 'pdf' });
}
function jsonBlob(s) { return new Blob([s], { type: 'application/json' }); }
function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}
function today() { return new Date().toISOString().slice(0, 10); }
async function ensureDir(root, parts) {
  let dir = root;
  for (const p of parts.filter(Boolean)) dir = await dir.getDirectoryHandle(p, { create: true });
  return dir;
}
async function writeFile(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(blob); await w.close();
}
