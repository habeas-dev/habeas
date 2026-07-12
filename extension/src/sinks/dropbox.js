// Dropbox delivery sink. Public app (PKCE, no client secret): the user pastes an app key + a one-time
// refresh token (token_access_type=offline), and we renew short-lived access tokens silently via the
// refresh token — cross-browser, no redirect URI to register (sidesteps Firefox's per-install UUID).
// Uploads via the content API; keeps a cumulative per-source manifest like the other sinks. The access
// token is cached encrypted in storage.local (only expiresAt stays plaintext), like the Drive token.
import { chrome } from '../lib/ext.js';
import { getSecret, encryptString, decryptString } from '../lib/secrets.js';
import { pathFor, toRecords, mergeRecords, jsonBlob } from './format.js';

const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';
const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download';
const mfName = (opts) => (opts && opts.source ? `${String(opts.source).replace(/[\\/:*?"<>|]+/g, '-')}.json` : 'manifest.json');
// Absolute Dropbox path "/Root/rel/parts" — normalized (no double slashes, single leading slash).
const dbxPath = (root, rel) => ('/' + String(root).replace(/^\/+|\/+$/g, '') + '/' + String(rel).replace(/^\/+/, '')).replace(/\/{2,}/g, '/');
// Dropbox-API-Arg is an HTTP header → must be ASCII; escape non-ASCII as \uXXXX (per Dropbox docs).
const apiArg = (obj) => JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

async function dropboxToken(sink) {
  const key = 'dbx:' + sink.id;
  const o = await chrome.storage.local.get(key);
  if (o[key] && o[key].expiresAt > Date.now() && o[key].tokenEnc) { const t = await decryptString(o[key].tokenEnc); if (t) return t; }
  const refresh = sink.refreshRef ? await getSecret(sink.refreshRef) : null;
  if (!refresh || !sink.appKey) throw new Error('dropbox: not connected (needs app key + refresh token)');
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: sink.appKey }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('dropbox refresh ' + r.status + ' ' + (d.error_description || d.error || ''));
  await chrome.storage.local.set({ [key]: { tokenEnc: await encryptString(d.access_token), expiresAt: Date.now() + (Number(d.expires_in || 14400) - 60) * 1000 } });
  return d.access_token;
}
async function dbxUpload(token, path, blob) {
  const r = await fetch(UPLOAD_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': apiArg({ path, mode: 'overwrite', mute: true }), 'Content-Type': 'application/octet-stream' }, body: blob });
  if (!r.ok) throw new Error('dropbox upload ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120));
}
async function dbxDownloadJson(token, path) {
  try {
    const r = await fetch(DOWNLOAD_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': apiArg({ path }) } });
    if (!r.ok) return []; // 409 path/not_found → no manifest yet
    return await r.json().catch(() => []);
  } catch (e) { return []; }
}

export async function dropboxWrite(sink, docs, files, opts = {}) {
  const token = await dropboxToken(sink);
  const root = sink.rootFolderName || 'Habeas';
  const service = opts.service || 'documents';
  let n = 0;
  for (const d of docs) for (const art of files.get(d.internalId) || []) { await dbxUpload(token, dbxPath(root, pathFor(sink, d, opts, art.ext)), art.blob); n++; }
  const mfPath = dbxPath(root, service + '/' + mfName(opts));
  const merged = mergeRecords(await dbxDownloadJson(token, mfPath), toRecords(docs, files));
  await dbxUpload(token, mfPath, jsonBlob(JSON.stringify(merged, null, 2)));
  return { written: n, total: docs.length };
}
