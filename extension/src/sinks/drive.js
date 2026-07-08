// Native Google Drive sink. OAuth via chrome.identity.launchWebAuthFlow (cross-browser,
// public client, implicit token flow — no client secret) with scope drive.file, which
// grants access ONLY to files this app creates and needs no Google CASA assessment.
import { chrome } from '../lib/ext.js';
import { pathFor, toRecords, mergeRecords } from './format.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
// Habeas ships with its own OAuth client (drive.file, non-sensitive → no CASA). A sink
// may override with its own Client ID. Client IDs are public, not secrets.
const DEFAULT_CLIENT_ID = '246972215385-rd4fbb1s7dmogjuqmmfhajcfe17hbubj.apps.googleusercontent.com';
const cid = (clientId) => clientId || DEFAULT_CLIENT_ID;

export function redirectUri() { return chrome.identity.getRedirectURL(); }

export async function connectDrive(clientId, interactive = true) {
  clientId = cid(clientId);
  const url = 'https://accounts.google.com/o/oauth2/v2/auth'
    + '?client_id=' + encodeURIComponent(clientId)
    + '&response_type=token'
    + '&redirect_uri=' + encodeURIComponent(chrome.identity.getRedirectURL())
    + '&scope=' + encodeURIComponent(SCOPE)
    // Silent refresh must NOT force a prompt (prompt=none → Google redirects with a token if the
    // user is signed in and already consented); the interactive first-connect asks for consent.
    + '&prompt=' + (interactive ? 'consent' : 'none');
  const details = { url, interactive };
  // Non-interactive flow: don't abort the moment the auth page loads — wait for its silent redirect
  // back with the token (the case the "User interaction required" error asks us to handle).
  if (!interactive) { details.abortOnLoadForNonInteractive = false; details.timeoutMsForNonInteractive = 8000; }
  const redir = await chrome.identity.launchWebAuthFlow(details);
  const p = new URLSearchParams(new URL(redir).hash.slice(1));
  const token = p.get('access_token');
  if (!token) throw new Error('sin token (' + (p.get('error') || 'desconocido') + ')');
  const rec = { token, expiresAt: Date.now() + (Number(p.get('expires_in') || 3600) - 60) * 1000 };
  await chrome.storage.session.set({ ['gdrive:' + clientId]: rec });
  return rec;
}

async function getToken(clientId, interactive) {
  clientId = cid(clientId);
  const key = 'gdrive:' + clientId;
  const o = await chrome.storage.session.get(key);
  if (o[key] && o[key].expiresAt > Date.now()) return o[key].token;
  try { return (await connectDrive(clientId, false)).token; }
  catch (e) { if (!interactive) throw e; return (await connectDrive(clientId, true)).token; }
}

export async function driveWrite(sink, docs, files, opts) {
  const token = await getToken(sink.clientId, opts.interactive !== false);
  const root = sink.rootFolderName || 'Habeas';
  const service = opts.service || 'documents';
  const cache = {};
  let n = 0;
  for (const d of docs) {
    for (const art of files.get(d.internalId) || []) {
      const rel = (root + '/' + pathFor(sink, d, opts, art.ext)).split('/').filter(Boolean);
      const folderId = await ensureFolderPath(token, rel.slice(0, -1), cache);
      await uploadFile(token, rel.at(-1), folderId, art.blob);
      n++;
    }
  }
  // Cumulative per-SOURCE manifest: Habeas/<service>/<source>.json (read → merge → write) so sources
  // sharing a service (e.g. WiZink movements vs statements) don't merge into one mixed file.
  const svcId = await ensureFolderPath(token, [root, service], cache);
  const mf = opts.source ? `${opts.source}.json` : 'manifest.json';
  const existing = await readJson(token, mf, svcId);
  const merged = mergeRecords(existing, toRecords(docs, files));
  await putJson(token, mf, svcId, JSON.stringify(merged, null, 2));
  return { written: n, total: docs.length };
}

async function ensureFolderPath(token, parts, cache) {
  let parentId = 'root', path = '';
  for (const name of parts) {
    path += '/' + name;
    if (!cache[path]) cache[path] = await findOrCreateFolder(token, name, parentId);
    parentId = cache[path];
  }
  return parentId;
}
async function findFile(token, name, parentId, folder = false) {
  const type = folder ? " and mimeType='application/vnd.google-apps.folder'" : '';
  const q = `name='${name.replace(/'/g, "\\'")}'${type} and '${parentId}' in parents and trashed=false`;
  const r = await fetch('https://www.googleapis.com/drive/v3/files?fields=files(id)&q=' + encodeURIComponent(q), { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('drive list ' + r.status);
  const d = await r.json();
  return d.files && d.files[0] ? d.files[0].id : null;
}
async function findOrCreateFolder(token, name, parentId) {
  const id = await findFile(token, name, parentId, true);
  if (id) return id;
  const cr = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  if (!cr.ok) throw new Error('drive mkdir ' + cr.status);
  return (await cr.json()).id;
}
async function readJson(token, name, parentId) {
  const id = await findFile(token, name, parentId);
  if (!id) return [];
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
async function putJson(token, name, parentId, text) {
  const id = await findFile(token, name, parentId);
  const blob = new Blob([text], { type: 'application/json' });
  if (id) {
    const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: blob,
    });
    if (!r.ok) throw new Error('drive manifest update ' + r.status);
  } else {
    await uploadFile(token, name, parentId, blob);
  }
}
async function uploadFile(token, name, parentId, blob) {
  const boundary = 'habeas' + Math.random().toString(36).slice(2);
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify({ name, parents: [parentId] }),
    `\r\n--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary },
    body,
  });
  if (!r.ok) throw new Error('drive upload ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120));
  return r.json();
}
