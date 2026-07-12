// Sinks: pluggable outputs. A sink writes documents (+ their PDF blobs) somewhere the
// user controls. Persistent sinks (local-folder, drive) keep a CUMULATIVE per-service
// manifest (<service>/manifest.json) so repeated syncs merge instead of clobbering, and
// different providers never collide. The ephemeral download ZIP carries a snapshot.
import { getSecret } from '../lib/secrets.js';
import { resolveSinkExtraHeaders } from '../lib/sinkheaders.js';
import { makeZip } from '../lib/zip.js';
import { pathFor, buildManifest, toRecords, mergeRecords, jsonBlob, today } from './format.js';
import { driveWrite, driveRead } from './drive.js';

export function listSinkTypes() { return ['download', 'local-folder', 'drive', 'http', 'webdav']; }

export async function writeToSink(sink, docs, files, opts = {}) {
  const impl = IMPL[sink.type];
  if (!impl) throw new Error('unknown sink type: ' + sink.type);
  return impl(sink, docs, files, opts);
}

// One manifest PER SOURCE (not per service) so different sources under the same service — e.g. WiZink
// card movements (transactions) vs monthly statements (invoices) — don't merge into one mixed file.
// The source id becomes a FILENAME, so strip characters the File System Access API rejects on every OS
// (a multi-output source's store key like "wizink-es:movimientos" carries a ":").
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '-');
const manifestName = (opts) => (opts && opts.source ? `${safeName(opts.source)}.json` : 'manifest.json');

const IMPL = {
  // Available PDFs + a <service>/manifest.json snapshot, bundled into one ZIP (the ZIP
  // only exists to dodge Chrome's multi-download block; other sinks write files directly).
  async download(sink, docs, files, opts) {
    const service = opts.service || 'documents';
    const entries = [];
    for (const d of docs) for (const art of files.get(d.internalId) || []) entries.push({ name: pathFor(sink, d, opts, art.ext), blob: art.blob });
    const written = entries.length;
    entries.push({ name: `${service}/${manifestName(opts)}`, blob: jsonBlob(buildManifest(docs, files)) });
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
    const mf = manifestName(opts);
    const existing = await readJsonFile(svcDir, mf);
    const merged = mergeRecords(existing, toRecords(docs, files));
    await writeFile(svcDir, mf, jsonBlob(JSON.stringify(merged, null, 2)));
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
    // Caller-supplied headers (e.g. an externally-proposed sink's pairing token) — resolved from the
    // encrypted headersRef, falling back to any legacy inline sink.headers. tokenRef wins on conflict.
    const headers = { ...(await resolveSinkExtraHeaders(sink)), ...(token ? { Authorization: 'Bearer ' + token } : {}) };
    const res = await fetch(sink.url, { method: 'POST', headers, body: form });
    if (!res.ok) throw new Error('http sink ' + res.status);
    return await res.json().catch(() => ({ written: docs.length, total: docs.length }));
  },

  // WebDAV (Nextcloud/ownCloud, Apache mod_dav, box.com/dav…): PUT each file under the base URL with
  // Basic auth, MKCOL'ing parent collections, and keep a cumulative per-source manifest (read → merge →
  // write) like the local-folder sink. Needs host permission for the server (like the http sink).
  async webdav(sink, docs, files, opts = {}) {
    const base = String(sink.url || '').replace(/\/+$/, '');
    if (!base) throw new Error('webdav: no url');
    const auth = await webdavAuthHeader(sink);
    const service = opts.service || 'documents';
    const made = new Set();
    let n = 0;
    for (const d of docs) {
      for (const art of files.get(d.internalId) || []) {
        const rel = pathFor(sink, d, opts, art.ext);
        await webdavMkcols(base, rel, auth, made);
        await webdavPut(base + '/' + encodePath(rel), art.blob, auth);
        n++;
      }
    }
    const mf = service + '/' + manifestName(opts);
    await webdavMkcols(base, mf, auth, made);
    const existing = await webdavGetJson(base + '/' + encodePath(mf), auth);
    const merged = mergeRecords(existing, toRecords(docs, files));
    await webdavPut(base + '/' + encodePath(mf), jsonBlob(JSON.stringify(merged, null, 2)), auth);
    return { written: n, total: docs.length };
  },
};

// --- WebDAV helpers ---------------------------------------------------------------------------------
const encodePath = (p) => String(p).split('/').filter(Boolean).map(encodeURIComponent).join('/');
async function webdavAuthHeader(sink) {
  const pass = sink.passwordRef ? await getSecret(sink.passwordRef) : '';
  const user = sink.username || '';
  if (!user && !pass) return null; // an open/pre-authenticated endpoint
  return 'Basic ' + btoa(unescape(encodeURIComponent(user + ':' + (pass || ''))));
}
async function webdavPut(url, blob, auth) {
  const r = await fetch(url, { method: 'PUT', headers: { ...(auth ? { Authorization: auth } : {}), 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
  if (!r.ok && r.status !== 204) throw new Error('webdav put ' + r.status);
}
async function webdavGetJson(url, auth) {
  try {
    const r = await fetch(url, { headers: { ...(auth ? { Authorization: auth } : {}), Accept: 'application/json' } });
    if (!r.ok) return []; // 404 → no manifest yet
    return await r.json().catch(() => []);
  } catch (e) { return []; }
}
// MKCOL each parent collection of `rel` (best-effort — a 405/301 means it already exists).
async function webdavMkcols(base, rel, auth, made) {
  const parts = rel.split('/').filter(Boolean).slice(0, -1); // drop the filename
  let path = '';
  for (const seg of parts) {
    path += (path ? '/' : '') + seg;
    if (made.has(path)) continue;
    made.add(path);
    try { await fetch(base + '/' + encodePath(path), { method: 'MKCOL', headers: auth ? { Authorization: auth } : {} }); } catch (e) { /* already exists / best-effort */ }
  }
}

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
async function openDir(root, parts) { // navigate WITHOUT creating (read path)
  let dir = root;
  for (const p of parts.filter(Boolean)) { try { dir = await dir.getDirectoryHandle(p); } catch (e) { return null; } }
  return dir;
}

// Read back the normalized records a generic, readable sink already holds for a source (its per-source
// manifest) — so the canonical store can be REHYDRATED from what was delivered, without re-extracting.
// Only store-capable sinks support this; a typed consumer / ephemeral download returns [].
export async function readSinkRecords(sink, opts = {}) {
  const service = opts.service || 'documents';
  if (sink.type === 'local-folder') {
    const root = opts.dirHandle; if (!root) return [];
    const svc = await openDir(root, [service]); if (!svc) return [];
    const recs = await readJsonFile(svc, manifestName(opts));
    return Array.isArray(recs) ? recs : [];
  }
  if (sink.type === 'drive') { const recs = await driveRead(sink, opts).catch(() => []); return Array.isArray(recs) ? recs : []; }
  return [];
}
async function writeFile(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(blob); await w.close();
}
async function readJsonFile(dir, name) {
  try { const fh = await dir.getFileHandle(name); return JSON.parse(await (await fh.getFile()).text()); }
  catch (e) { return []; }
}
