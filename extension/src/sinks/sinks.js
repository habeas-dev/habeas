// Sinks: pluggable outputs. A sink writes documents (+ their PDF blobs) somewhere the
// user controls. All sinks share writeToSink(sink, docs, files, opts).
import { getSecret } from '../lib/secrets.js';
import { renderPath } from '../lib/naming.js';

export function listSinkTypes() { return ['download', 'local-folder', 'drive', 'http']; }

export async function writeToSink(sink, docs, files, opts = {}) {
  const impl = IMPL[sink.type];
  if (!impl) throw new Error('unknown sink type: ' + sink.type);
  return impl(sink, docs, files, opts);
}

const IMPL = {
  // Browser downloads — zero config.
  async download(sink, docs, files, opts) {
    let n = 0;
    for (const d of docs) {
      const blob = files.get(d.externalId); if (!blob) continue;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = pathFor(sink, d, opts).replace(/\//g, '-');
      document.body.appendChild(a); a.click(); a.remove();
      await sleep(300); URL.revokeObjectURL(url); n++;
    }
    return { written: n };
  },

  // Local folder via File System Access. opts.dirHandle provided by the UI (user gesture).
  // Point it at a Drive/Dropbox-synced folder to get "cloud" for free.
  async ['local-folder'](sink, docs, files, opts) {
    const root = opts.dirHandle;
    if (!root) throw new Error('no directory handle (elige carpeta)');
    let n = 0;
    for (const d of docs) {
      const blob = files.get(d.externalId); if (!blob) continue;
      const rel = pathFor(sink, d, opts).split('/');
      const dir = await ensureDir(root, rel.slice(0, -1));
      const fh = await dir.getFileHandle(rel.at(-1), { create: true });
      const w = await fh.createWritable(); await w.write(blob); await w.close(); n++;
    }
    return { written: n };
  },

  // Native Google Drive — pending the project's own OAuth client (scope drive.file).
  async drive() {
    throw new Error('Sink Drive nativo: pendiente del client OAuth (scope drive.file). Ver spec §6.9.');
  },

  // HTTP consumer (Tiquetera / Cuéntamo): POST normalized records + PDFs.
  async http(sink, docs, files) {
    const token = await getSecret(sink.tokenRef);
    const form = new FormData();
    form.append('records', JSON.stringify(docs.map(toRecord)));
    for (const d of docs) { const b = files.get(d.externalId); if (b) form.append('files[]', b, d.externalId + '.pdf'); }
    const res = await fetch(sink.url, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: form });
    if (!res.ok) throw new Error('http sink ' + res.status);
    return await res.json().catch(() => ({ written: docs.length }));
  },
};

function pathFor(sink, d, opts) {
  const tpl = sink.pathTemplate || '{service}/{yyyy}/{date}-{externalId}.pdf';
  return renderPath(tpl, {
    service: opts.service || 'documents',
    date: (d.date || '').slice(0, 10),
    externalId: d.externalId, ext: 'pdf',
  });
}
function toRecord(d) {
  return { externalId: d.externalId, date: d.date, total: d.total, currency: 'EUR', store: { name: d.storeName, address: d.storeAddress }, source: d.source, type: d.type };
}
async function ensureDir(root, parts) {
  let dir = root;
  for (const p of parts.filter(Boolean)) dir = await dir.getDirectoryHandle(p, { create: true });
  return dir;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
