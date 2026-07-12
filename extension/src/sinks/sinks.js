// Sinks: pluggable outputs. A sink writes documents (+ their PDF blobs) somewhere the
// user controls. Persistent sinks (local-folder, drive) keep a CUMULATIVE per-service
// manifest (<service>/manifest.json) so repeated syncs merge instead of clobbering, and
// different providers never collide. The ephemeral download ZIP carries a snapshot.
import { getSecret } from '../lib/secrets.js';
import { sigv4Sign, sha256Hex } from '../lib/sigv4.js';
import { resolveSinkExtraHeaders } from '../lib/sinkheaders.js';
import { makeZip } from '../lib/zip.js';
import { pathFor, buildManifest, toRecords, mergeRecords, jsonBlob, today } from './format.js';
import { driveWrite, driveRead } from './drive.js';
import { dropboxWrite } from './dropbox.js';

export function listSinkTypes() { return ['download', 'local-folder', 'drive', 'http', 'webdav', 's3', 'dropbox']; }

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

  // Dropbox — content-API uploads + cumulative manifest (see dropbox.js).
  dropbox: (sink, docs, files, opts) => dropboxWrite(sink, docs, files, opts),

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

  // S3 (and S3-compatible: MinIO, Cloudflare R2, Backblaze B2): PUT each object under an optional key
  // prefix via SigV4, and keep a cumulative per-source manifest. Credentials (access key + secret) live
  // in the encrypted secrets store (secretRef). Needs host permission for the endpoint (like the http sink).
  async s3(sink, docs, files, opts = {}) {
    const cfg = await s3Config(sink);
    if (!cfg.bucket || !cfg.accessKeyId) throw new Error('s3: bucket + accessKeyId required');
    const service = opts.service || 'documents';
    let n = 0;
    for (const d of docs) {
      for (const art of files.get(d.internalId) || []) {
        await s3Put(cfg, s3Key(cfg, pathFor(sink, d, opts, art.ext)), art.blob);
        n++;
      }
    }
    const mfKey = s3Key(cfg, service + '/' + manifestName(opts));
    const merged = mergeRecords(await s3GetJson(cfg, mfKey), toRecords(docs, files));
    await s3Put(cfg, mfKey, jsonBlob(JSON.stringify(merged, null, 2)));
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

// --- S3 helpers (AWS + S3-compatible: MinIO, Cloudflare R2, Backblaze B2) via SigV4 --------------------
const S3_EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const amzNow = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
async function s3Config(sink) {
  return {
    endpoint: sink.endpoint ? String(sink.endpoint).replace(/\/+$/, '') : '', // custom (MinIO/R2/B2); else AWS
    region: sink.region || 'us-east-1',
    bucket: sink.bucket,
    accessKeyId: sink.accessKeyId,
    secretAccessKey: sink.secretRef ? await getSecret(sink.secretRef) : '',
    prefix: sink.prefix || '',
    pathStyle: !!sink.pathStyle || !!sink.endpoint, // custom endpoints are usually path-style
  };
}
const s3Key = (cfg, rel) => [cfg.prefix, rel].filter(Boolean).join('/').replace(/\/{2,}/g, '/').replace(/^\//, '');
function s3Url(cfg, key) {
  const enc = String(key).split('/').filter(Boolean).map(encodeURIComponent).join('/');
  if (cfg.endpoint) return cfg.pathStyle ? `${cfg.endpoint}/${cfg.bucket}/${enc}` : `${cfg.endpoint}/${enc}`;
  return cfg.pathStyle ? `https://s3.${cfg.region}.amazonaws.com/${cfg.bucket}/${enc}` : `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${enc}`;
}
async function s3Put(cfg, key, blob) {
  const body = new Uint8Array(await blob.arrayBuffer());
  const url = s3Url(cfg, key);
  const { headers } = await sigv4Sign({ method: 'PUT', url, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, amzDate: amzNow(), payloadHash: await sha256Hex(body), extraHeaders: { 'content-type': blob.type || 'application/octet-stream' } });
  const r = await fetch(url, { method: 'PUT', headers, body });
  if (!r.ok) throw new Error('s3 put ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120));
}
async function s3GetJson(cfg, key) {
  try {
    const url = s3Url(cfg, key);
    const { headers } = await sigv4Sign({ method: 'GET', url, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, amzDate: amzNow(), payloadHash: S3_EMPTY_SHA });
    const r = await fetch(url, { headers });
    if (!r.ok) return []; // 404 → no manifest yet
    return await r.json().catch(() => []);
  } catch (e) { return []; }
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

// --- Canonical-store backends (reuse the delivery sinks' primitives) --------------------------------
// Per-source JSON at <storeFolder>/<sourceId>.json under the sink's target, reusing its credentials.
// All ops best-effort/silent — a store read/write must never break a List or delivery.
export function webdavStore(sink, cfg = {}) {
  const base = String(sink.url || '').replace(/\/+$/, '');
  const folder = (cfg && cfg.storeFolder) || '_store';
  const rel = (id) => folder + '/' + id + '.json';
  return {
    async loadSource(id) {
      try { const auth = await webdavAuthHeader(sink); const j = await webdavGetJson(base + '/' + encodePath(rel(id)), auth); return j && typeof j === 'object' && !Array.isArray(j) && j.items ? j : null; } catch (e) { return null; }
    },
    async saveSource(id, data) {
      try { const auth = await webdavAuthHeader(sink); await webdavMkcols(base, rel(id), auth, new Set()); await webdavPut(base + '/' + encodePath(rel(id)), jsonBlob(JSON.stringify(data)), auth); } catch (e) { /* best-effort */ }
    },
    async listSources() {
      try {
        const auth = await webdavAuthHeader(sink);
        const r = await fetch(base + '/' + encodePath(folder) + '/', { method: 'PROPFIND', headers: { ...(auth ? { Authorization: auth } : {}), Depth: '1' } });
        if (!r.ok) return [];
        const txt = await r.text();
        return [...new Set([...txt.matchAll(/href\s*>\s*([^<]+?\.json)\s*<\/[a-z:]*href/gi)].map((m) => decodeURIComponent(m[1].split('/').filter(Boolean).pop()).replace(/\.json$/, '')))];
      } catch (e) { return []; }
    },
  };
}

export function s3Store(sink, cfg = {}) {
  const folder = (cfg && cfg.storeFolder) || '_store';
  const keyOf = (id) => folder + '/' + id + '.json';
  return {
    async loadSource(id) {
      try { const c = await s3Config(sink); const j = await s3GetJson(c, s3Key(c, keyOf(id))); return j && typeof j === 'object' && !Array.isArray(j) && j.items ? j : null; } catch (e) { return null; }
    },
    async saveSource(id, data) {
      try { const c = await s3Config(sink); await s3Put(c, s3Key(c, keyOf(id)), jsonBlob(JSON.stringify(data))); } catch (e) { /* best-effort */ }
    },
    async listSources() {
      try {
        const c = await s3Config(sink);
        const bucketRoot = c.endpoint ? (c.pathStyle ? `${c.endpoint}/${c.bucket}` : c.endpoint) : (c.pathStyle ? `https://s3.${c.region}.amazonaws.com/${c.bucket}` : `https://${c.bucket}.s3.${c.region}.amazonaws.com`);
        const url = `${bucketRoot}/?list-type=2&prefix=${encodeURIComponent(s3Key(c, folder + '/'))}`;
        const { headers } = await sigv4Sign({ method: 'GET', url, region: c.region, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, amzDate: amzNow(), payloadHash: S3_EMPTY_SHA });
        const r = await fetch(url, { headers });
        if (!r.ok) return [];
        const txt = await r.text();
        return [...new Set([...txt.matchAll(/<Key>\s*([^<]+?)\.json\s*<\/Key>/gi)].map((m) => m[1].split('/').filter(Boolean).pop()))];
      } catch (e) { return []; }
    },
  };
}
