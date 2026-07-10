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
// Per-source manifest filename; strip characters Drive/paths reject (a multi-output store key carries a ":").
const mfName = (opts) => (opts && opts.source ? `${String(opts.source).replace(/[\\/:*?"<>|]+/g, '-')}.json` : 'manifest.json');

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
  // Persist in storage.local (survives browser restart) so the user isn't re-prompted on every Chrome open.
  // This is the delivery-sink OAuth token (scope drive.file), NOT a scraped site session — those still live
  // only in storage.session (rule #3). It's short-lived (~1h); a silent prompt=none refresh renews it.
  await chrome.storage.local.set({ ['gdrive:' + clientId]: rec });
  return rec;
}

async function getToken(clientId, interactive) {
  clientId = cid(clientId);
  const key = 'gdrive:' + clientId;
  const o = await chrome.storage.local.get(key);
  if (o[key] && o[key].expiresAt > Date.now()) return o[key].token; // valid cached token → no network, no prompt
  try { return (await connectDrive(clientId, false)).token; }        // silent refresh (prompt=none)
  catch (e) { if (!interactive) throw e; return (await connectDrive(clientId, true)).token; } // only NOW a UI prompt
}

// A valid (non-expired) Drive token is cached → treat as "connected". Persisted in storage.local, so this
// survives a browser restart (unlike before, when it reset every session and forced a re-auth).
export async function driveConnected(clientId) {
  const key = 'gdrive:' + cid(clientId);
  const o = await chrome.storage.local.get(key);
  return !!(o[key] && o[key].token && o[key].expiresAt > Date.now());
}
// Forget the cached token (the "disconnect" affordance). We don't revoke server-side — dropping the token
// is enough to stop using Drive; the user can revoke access from their Google account if they wish.
export async function disconnectDrive(clientId) {
  try { await chrome.storage.local.remove('gdrive:' + cid(clientId)); } catch (e) {}
}

// Read back a source's per-source manifest (records) already in Drive — to rehydrate the canonical store
// without re-extracting. Returns [] if the folder/file isn't there yet.
export async function driveRead(sink, opts = {}) {
  const token = await getToken(sink.clientId, opts.interactive !== false);
  const root = sink.rootFolderName || 'Habeas';
  const service = opts.service || 'documents';
  const rootId = await findFile(token, root, 'root', true); if (!rootId) return [];
  const svcId = await findFile(token, service, rootId, true); if (!svcId) return [];
  const mf = mfName(opts);
  const recs = await readJson(token, mf, svcId);
  return Array.isArray(recs) ? recs : [];
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
  const mf = mfName(opts);
  const existing = await readJson(token, mf, svcId);
  const merged = mergeRecords(existing, toRecords(docs, files));
  await putJson(token, mf, svcId, JSON.stringify(merged, null, 2));
  return { written: n, total: docs.length };
}

// Canonical-store backend on Drive: each source's store JSON at Habeas/<storeFolder>/<sourceId>.json,
// kept apart from the delivered-record manifests (Habeas/<service>/…) so the store never mixes with files.
// Drive filenames allow ":" (unlike the File System Access API), so the sourceId — which may be a stream
// key like "wizink-es:movimientos" — is used verbatim, keeping listSources() a faithful round-trip.
export function driveStore(cfg = {}) {
  const clientId = cfg.clientId;
  const root = cfg.rootFolderName || 'Habeas';
  const sub = cfg.storeFolder || '_store';
  // A store on Drive DOES need to authorize — so a real op (List / deliver) prompts when no token can be
  // obtained silently. But a PASSIVE read (the popup's count hint) passes {interactive:false} so it never
  // pops the window just to show a number; it silently no-ops instead. The token persists in storage.local,
  // so after the one grant a valid token is reused across restarts (no prompt every Chrome open).
  const interactive = cfg.interactive !== false;
  const ia = (opts) => (opts && opts.interactive === false ? false : interactive);
  const dirId = async (token) => ensureFolderPath(token, [root, sub], {});
  return {
    async loadSource(id, opts) {
      const token = await getToken(clientId, ia(opts));
      const j = await readJson(token, id + '.json', await dirId(token));
      return j && typeof j === 'object' && !Array.isArray(j) && j.items ? j : null; // a store source object, not the [] readJson miss
    },
    async saveSource(id, data) {
      const token = await getToken(clientId, interactive);
      await putJson(token, id + '.json', await dirId(token), JSON.stringify(data));
    },
    async listSources() {
      const token = await getToken(clientId, interactive);
      const rootId = await findFile(token, root, 'root', true); if (!rootId) return [];
      const subId = await findFile(token, sub, rootId, true); if (!subId) return [];
      return listFolderJson(token, subId);
    },
  };
}
async function listFolderJson(token, parentId) {
  const q = `'${parentId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
  const r = await fetch('https://www.googleapis.com/drive/v3/files?fields=files(name)&q=' + encodeURIComponent(q), { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return [];
  const d = await r.json().catch(() => ({}));
  return (d.files || []).map((f) => f.name).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
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
