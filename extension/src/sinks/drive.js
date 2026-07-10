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

// PATH A (Chrome, preferred): chrome.identity.getAuthToken. Chrome holds a long-lived grant tied to the
// signed-in Google account and silently mints/refreshes access tokens FOREVER after one consent — no 1h
// re-prompt, no refresh-token handling by us. Requires manifest.oauth2 (a "Chrome Extension"-type OAuth
// client). When it isn't configured (or on Firefox, which has no getAuthToken), we fall back to PATH B.
function hasChromeAuth() {
  try { const m = chrome.runtime.getManifest(); return !!(chrome.identity && chrome.identity.getAuthToken && m.oauth2 && m.oauth2.client_id); } catch (e) { return false; }
}
function chromeGetToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: !!interactive }, (r) => {
      const err = chrome.runtime.lastError;
      const token = r && (typeof r === 'string' ? r : r.token);
      if (err || !token) reject(new Error(err ? err.message : 'no token')); else resolve(token);
    });
  });
}
export function removeCachedToken(token) { // call on a 401 so getAuthToken re-mints instead of returning a stale token
  try { if (hasChromeAuth() && token) chrome.identity.removeCachedAuthToken({ token }, () => {}); } catch (e) {}
}

// PATH B (fallback, cross-browser): the implicit flow, token cached in storage.local (survives restart) with
// a silent prompt=none refresh.
async function getToken(clientId, interactive) {
  // Path A first (silent-forever after one consent). If it fails for ANY reason — OAuth client misconfig,
  // the extension ID not matching the client, consent not yet granted on this build — fall through to Path B
  // so Drive still works via the implicit flow instead of breaking outright.
  if (hasChromeAuth()) { try { return await chromeGetToken(interactive); } catch (e) { /* → Path B */ } }
  clientId = cid(clientId);
  const key = 'gdrive:' + clientId;
  const o = await chrome.storage.local.get(key);
  if (o[key] && o[key].expiresAt > Date.now()) return o[key].token; // valid cached token → no network, no prompt
  try { return (await connectDrive(clientId, false)).token; }        // silent refresh (prompt=none)
  catch (e) { if (!interactive) throw e; return (await connectDrive(clientId, true)).token; } // only NOW a UI prompt
}

// Run a Drive operation with a token, re-minting ONCE on a 401 (Path A: getAuthToken can hand back a token
// Chrome believes valid but the server rejected — removeCachedToken forces a fresh mint). fn receives the token.
async function withToken(clientId, interactive, fn) {
  const token = await getToken(clientId, interactive);
  try { return await fn(token); }
  catch (e) {
    if (hasChromeAuth() && /(^|\D)401(\D|$)/.test(String((e && e.message) || ''))) {
      removeCachedToken(token);
      return await fn(await getToken(clientId, interactive));
    }
    throw e;
  }
}

// "Connected" = a token can be obtained SILENTLY (Path A: Chrome has a grant; Path B: a valid cached token).
export async function driveConnected(clientId) {
  if (hasChromeAuth()) { try { await chromeGetToken(false); return true; } catch (e) { return false; } }
  const key = 'gdrive:' + cid(clientId);
  const o = await chrome.storage.local.get(key);
  return !!(o[key] && o[key].token && o[key].expiresAt > Date.now());
}
// Disconnect: Path A → drop Chrome's cached token; Path B → drop the stored token. (We don't revoke the grant
// server-side; the user can do that from their Google account.)
export async function disconnectDrive(clientId) {
  if (hasChromeAuth()) { try { removeCachedToken(await chromeGetToken(false)); } catch (e) {} return; }
  try { await chrome.storage.local.remove('gdrive:' + cid(clientId)); } catch (e) {}
}

// Read back a source's per-source manifest (records) already in Drive — to rehydrate the canonical store
// without re-extracting. Returns [] if the folder/file isn't there yet.
export async function driveRead(sink, opts = {}) {
  return withToken(sink.clientId, opts.interactive !== false, async (token) => {
    const root = sink.rootFolderName || 'Habeas';
    const service = opts.service || 'documents';
    const rootId = await findFile(token, root, 'root', true); if (!rootId) return [];
    const svcId = await findFile(token, service, rootId, true); if (!svcId) return [];
    const recs = await readJson(token, mfName(opts), svcId);
    return Array.isArray(recs) ? recs : [];
  });
}

export async function driveWrite(sink, docs, files, opts) {
  return withToken(sink.clientId, opts.interactive !== false, async (token) => {
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
  });
}

// Canonical-store backend on Drive: each source's store JSON at Habeas/<storeFolder>/<sourceId>.json,
// kept apart from the delivered-record manifests (Habeas/<service>/…) so the store never mixes with files.
// Drive filenames allow ":" (unlike the File System Access API), so the sourceId — which may be a stream
// key like "wizink-es:movimientos" — is used verbatim, keeping listSources() a faithful round-trip.
export function driveStore(cfg = {}) {
  const clientId = cfg.clientId;
  const root = cfg.rootFolderName || 'Habeas';
  const sub = cfg.storeFolder || '_store';
  // The store NEVER pops the OAuth window on its own — its reads/writes run in the background (auto-sync
  // write-through, the popup's count hint) where a surprise prompt is jarring, and an expired-token refresh
  // that can't complete silently would otherwise pop "every now and then". So all store ops are SILENT
  // (prompt=none): a valid/renewable token → they work; otherwise they no-op (best-effort). The user grants
  // ONCE via Settings → "Connect Drive" (the only interactive path). Token persists in storage.local.
  const interactive = cfg.interactive === true; // default false — opt in explicitly (Connect Drive button)
  const ia = (opts) => (opts && opts.interactive === false ? false : interactive);
  const dirId = async (token) => ensureFolderPath(token, [root, sub], {});
  // Best-effort: a silent-token failure (or a transient Drive error) must NOT throw — it would break a List
  // or a delivery. Reads → null (no store data), writes → skipped. The user reconnects via Settings.
  return {
    async loadSource(id, opts) {
      try {
        return await withToken(clientId, ia(opts), async (token) => {
          const j = await readJson(token, id + '.json', await dirId(token));
          return j && typeof j === 'object' && !Array.isArray(j) && j.items ? j : null; // a store source object, not the [] readJson miss
        });
      } catch (e) { return null; }
    },
    async saveSource(id, data) {
      try {
        await withToken(clientId, interactive, async (token) => putJson(token, id + '.json', await dirId(token), JSON.stringify(data)));
      } catch (e) { /* can't reach the Drive store right now → keep it best-effort */ }
    },
    async listSources() {
      try {
        return await withToken(clientId, interactive, async (token) => {
          const rootId = await findFile(token, root, 'root', true); if (!rootId) return [];
          const subId = await findFile(token, sub, rootId, true); if (!subId) return [];
          return listFolderJson(token, subId);
        });
      } catch (e) { return []; }
    },
  };
}
async function listFolderJson(token, parentId) {
  const q = `'${parentId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
  const r = await fetch('https://www.googleapis.com/drive/v3/files?fields=files(name)&q=' + encodeURIComponent(q), { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401) throw new Error('drive 401'); // let withToken re-mint
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
  if (r.status === 401) throw new Error('drive 401'); // let withToken re-mint
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
