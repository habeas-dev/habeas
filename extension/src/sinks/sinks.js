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
import { dropboxWrite, dropboxRetrieve } from './dropbox.js';
import { makeShardedStore, pathPrim } from '../lib/store/sharded.js';

export function listSinkTypes() { return ['download', 'local-folder', 'drive', 'http', 'webdav', 's3', 'dropbox']; }

export async function writeToSink(sink, docs, files, opts = {}) {
  const impl = IMPL[sink.type];
  if (!impl) throw new Error('unknown sink type: ' + sink.type);
  // A sink can opt into the uniform canonical manifest shape (sink.normalize) — e.g. a consumer that wants
  // the same record shape regardless of source. Threaded to the manifest builders via opts.
  return impl(sink, docs, files, { ...opts, normalize: opts.normalize ?? sink.normalize });
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
    entries.push({ name: `${service}/${manifestName(opts)}`, blob: jsonBlob(buildManifest(docs, files, opts)) });
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
    const merged = mergeRecords(existing, toRecords(docs, files, opts));
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
    form.append('records', buildManifest(docs, files, opts));
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
    const merged = mergeRecords(existing, toRecords(docs, files, opts));
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
    const merged = mergeRecords(await s3GetJson(cfg, mfKey), toRecords(docs, files, opts));
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
async function s3Delete(cfg, key) {
  const url = s3Url(cfg, key);
  const { headers } = await sigv4Sign({ method: 'DELETE', url, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, amzDate: amzNow(), payloadHash: S3_EMPTY_SHA });
  const r = await fetch(url, { method: 'DELETE', headers });
  if (!r.ok && r.status !== 404) throw new Error('s3 delete ' + r.status);
}
const s3BucketRoot = (c) => c.endpoint ? (c.pathStyle ? `${c.endpoint}/${c.bucket}` : c.endpoint) : (c.pathStyle ? `https://s3.${c.region}.amazonaws.com/${c.bucket}` : `https://${c.bucket}.s3.${c.region}.amazonaws.com`);

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
  // Generic readable sinks: the cumulative per-source manifest lives at <service>/<source>.json. Fetch + parse it.
  const rel = service + '/' + manifestName(opts);
  let blob = null;
  try {
    if (sink.type === 'dropbox') blob = await dropboxRetrieve(sink, rel);
    else if (sink.type === 'webdav') blob = await webdavRetrieve(sink, rel);
    else if (sink.type === 's3') blob = await s3Retrieve(sink, rel);
  } catch (e) { return []; }
  if (!blob) return [];
  try { const j = JSON.parse(await blob.text()); return Array.isArray(j) ? j : []; } catch (e) { return []; }
}
async function writeFile(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(blob); await w.close();
}
async function readJsonFile(dir, name) {
  try { const fh = await dir.getFileHandle(name); return JSON.parse(await (await fh.getFile()).text()); }
  catch (e) { return []; }
}

// --- Retrieve a delivered artifact (relative path under the sink's target) as a Blob, for the in-app
// document viewer. null if absent; throws on a real error. Mirror the delivery sinks' rooting/auth. -------
export async function webdavRetrieve(sink, relPath) {
  const base = String(sink.url || '').replace(/\/+$/, '');
  const auth = await webdavAuthHeader(sink);
  const r = await fetch(base + '/' + encodePath(relPath), { headers: auth ? { Authorization: auth } : {} });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`WebDAV GET ${r.status}`);
  return await r.blob();
}
export async function s3Retrieve(sink, relPath) {
  const cfg = await s3Config(sink);
  const url = s3Url(cfg, s3Key(cfg, relPath));
  const { headers } = await sigv4Sign({ method: 'GET', url, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, amzDate: amzNow(), payloadHash: S3_EMPTY_SHA });
  const r = await fetch(url, { headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`S3 GET ${r.status}`);
  return await r.blob();
}
export async function folderRetrieve(dirHandle, relPath) {
  let dir = dirHandle;
  const parts = String(relPath).split('/').filter(Boolean);
  const name = parts.pop();
  for (const p of parts) dir = await dir.getDirectoryHandle(p);
  return await (await dir.getFileHandle(name)).getFile();
}

// --- Existence checks (no download) — used to scan which formats a delivered doc has cheaply. ---
export async function webdavExists(sink, relPath) {
  const base = String(sink.url || '').replace(/\/+$/, '');
  const auth = await webdavAuthHeader(sink);
  const url = base + '/' + encodePath(relPath);
  let r = await fetch(url, { method: 'HEAD', headers: auth ? { Authorization: auth } : {} });
  if (r.status === 405 || r.status === 501) r = await fetch(url, { method: 'GET', headers: { ...(auth ? { Authorization: auth } : {}), Range: 'bytes=0-0' } }); // HEAD unsupported → tiny ranged GET
  if (r.status === 404) return false;
  if (!r.ok && r.status !== 206) throw new Error(`WebDAV HEAD ${r.status}`);
  return true;
}
export async function s3Exists(sink, relPath) {
  const cfg = await s3Config(sink);
  const url = s3Url(cfg, s3Key(cfg, relPath));
  const { headers } = await sigv4Sign({ method: 'HEAD', url, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, amzDate: amzNow(), payloadHash: S3_EMPTY_SHA });
  const r = await fetch(url, { method: 'HEAD', headers });
  if (r.status === 404) return false;
  if (!r.ok) throw new Error(`S3 HEAD ${r.status}`);
  return true;
}
export async function folderExists(dirHandle, relPath) {
  let dir = dirHandle;
  const parts = String(relPath).split('/').filter(Boolean);
  const name = parts.pop();
  for (const p of parts) dir = await dir.getDirectoryHandle(p);
  await dir.getFileHandle(name); // throws NotFoundError if the file is missing
  return true;
}

// --- Canonical-store backends (reuse the delivery sinks' primitives) --------------------------------
// Per-source JSON at <storeFolder>/<sourceId>.json under the sink's target, reusing its credentials.
// All ops best-effort/silent — a store read/write must never break a List or delivery.
// Month-SHARDED (see lib/store/sharded.js). io supplies path file I/O; the sharded/pathPrim layer does the rest.
export function webdavStore(sink, cfg = {}) {
  const base = String(sink.url || '').replace(/\/+$/, '');
  const folder = (cfg && cfg.storeFolder) || '_store';
  const url = (rel) => base + '/' + encodePath(rel);
  const io = {
    async readJson(rel) {
      try { const auth = await webdavAuthHeader(sink); const r = await fetch(url(rel), { headers: { ...(auth ? { Authorization: auth } : {}), Accept: 'application/json' } }); if (!r.ok) return null; const j = await r.json().catch(() => null); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch (e) { return null; }
    },
    async writeJson(rel, obj) { const auth = await webdavAuthHeader(sink); await webdavMkcols(base, rel, auth, new Set()); await webdavPut(url(rel), jsonBlob(JSON.stringify(obj)), auth); },
    async removePath(rel) { try { const auth = await webdavAuthHeader(sink); await fetch(url(rel), { method: 'DELETE', headers: auth ? { Authorization: auth } : {} }); } catch (e) { /* best-effort */ } },
    async removeDir(rel) { try { const auth = await webdavAuthHeader(sink); await fetch(url(rel) + '/', { method: 'DELETE', headers: auth ? { Authorization: auth } : {} }); } catch (e) { /* best-effort */ } },
    async listDir(rel) {
      try {
        const auth = await webdavAuthHeader(sink);
        const dirUrl = url(rel) + '/';
        const r = await fetch(dirUrl, { method: 'PROPFIND', headers: { ...(auth ? { Authorization: auth } : {}), Depth: '1' } });
        if (!r.ok) return [];
        const txt = await r.text();
        const self = decodeURIComponent(new URL(dirUrl).pathname).replace(/\/+$/, '');
        const out = [];
        for (const m of txt.matchAll(/<[a-z0-9]*:?response\b[\s\S]*?<\/[a-z0-9]*:?response>/gi)) {
          const block = m[0]; const hm = block.match(/<[a-z0-9]*:?href\s*>\s*([^<]+?)\s*<\/[a-z0-9]*:?href>/i); if (!hm) continue;
          const href = decodeURIComponent(hm[1]); const hp = (href.startsWith('http') ? new URL(href).pathname : href);
          if (hp.replace(/\/+$/, '') === self) continue; // the collection itself
          const isDir = /<[a-z0-9]*:?collection\b/i.test(block) || href.endsWith('/');
          const name = hp.replace(/\/+$/, '').split('/').filter(Boolean).pop();
          if (name) out.push({ name, isDir });
        }
        return out;
      } catch (e) { return []; }
    },
  };
  return makeShardedStore(pathPrim(io, folder));
}

// Month-SHARDED (see lib/store/sharded.js). S3 has no real folders → listDir uses a delimiter listing.
export function s3Store(sink, cfg = {}) {
  const folder = (cfg && cfg.storeFolder) || '_store';
  const io = {
    async readJson(rel) {
      try { const c = await s3Config(sink); const url = s3Url(c, s3Key(c, rel)); const { headers } = await sigv4Sign({ method: 'GET', url, region: c.region, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, amzDate: amzNow(), payloadHash: S3_EMPTY_SHA }); const r = await fetch(url, { headers }); if (!r.ok) return null; const j = await r.json().catch(() => null); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch (e) { return null; }
    },
    async writeJson(rel, obj) { const c = await s3Config(sink); await s3Put(c, s3Key(c, rel), jsonBlob(JSON.stringify(obj))); },
    async removePath(rel) { try { const c = await s3Config(sink); await s3Delete(c, s3Key(c, rel)); } catch (e) { /* best-effort */ } },
    async listDir(rel) {
      try {
        const c = await s3Config(sink);
        const prefix = s3Key(c, rel + '/');
        const url = `${s3BucketRoot(c)}/?list-type=2&delimiter=%2F&prefix=${encodeURIComponent(prefix)}`;
        const { headers } = await sigv4Sign({ method: 'GET', url, region: c.region, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, amzDate: amzNow(), payloadHash: S3_EMPTY_SHA });
        const r = await fetch(url, { headers }); if (!r.ok) return [];
        const txt = await r.text(); const out = [];
        for (const m of txt.matchAll(/<Key>\s*([^<]+?)\s*<\/Key>/gi)) { if (m[1] === prefix) continue; const name = m[1].split('/').filter(Boolean).pop(); if (name) out.push({ name, isDir: false }); }
        for (const m of txt.matchAll(/<Prefix>\s*([^<]+?)\s*<\/Prefix>/gi)) { if (m[1] === prefix) continue; const name = m[1].replace(/\/+$/, '').split('/').filter(Boolean).pop(); if (name) out.push({ name, isDir: true }); }
        return out;
      } catch (e) { return []; }
    },
  };
  return makeShardedStore(pathPrim(io, folder)); // no removeDir → removeSource deletes each child object
}
