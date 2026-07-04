// Sinks: pluggable outputs. A sink writes documents (+ their PDF blobs) somewhere the
// user controls. Every sink also emits a manifest.json with the normalized records for
// ALL selected documents — including those whose PDF Carrefour no longer retains.
import { getSecret } from '../lib/secrets.js';
import { makeZip } from '../lib/zip.js';
import { pathFor, buildManifest, jsonBlob, today } from './format.js';
import { driveWrite } from './drive.js';

export function listSinkTypes() { return ['download', 'local-folder', 'drive', 'http']; }

export async function writeToSink(sink, docs, files, opts = {}) {
  const impl = IMPL[sink.type];
  if (!impl) throw new Error('unknown sink type: ' + sink.type);
  return impl(sink, docs, files, opts);
}

const IMPL = {
  // Available PDFs + a manifest.json of ALL selected docs, bundled into one ZIP (the ZIP
  // only exists to dodge Chrome's multi-download block; other sinks write files directly).
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

  // Native Google Drive — individual file uploads (no ZIP needed).
  drive: (sink, docs, files, opts) => driveWrite(sink, docs, files, opts),

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
