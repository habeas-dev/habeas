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

// Habeas ships its own Dropbox app (public — PKCE needs NO client secret, so the app key is publishable,
// unlike Google's device secret). A sink may override it. Empty until the project app is registered; the
// per-sink appKey field then carries a user's own app.
const DEFAULT_DROPBOX_APP_KEY = '';
const dbxAppKey = (sink) => (sink && sink.appKey) || DEFAULT_DROPBOX_APP_KEY;

// PKCE helpers (S256) — Web Crypto only, so this runs in the service worker / an extension page.
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function pkceVerifier() { const a = new Uint8Array(64); crypto.getRandomValues(a); return b64url(a); }
async function pkceChallenge(verifier) { return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))); }

// Persist a token response under gdrive-style cache: access token (encrypted) + expiry, and — first time
// / on connect — the long-lived refresh token (encrypted). Merges so a refresh (no refresh_token in the
// response) keeps the stored one.
async function storeDropboxTokens(sinkId, d) {
  const key = 'dbx:' + sinkId;
  const cur = (await chrome.storage.local.get(key))[key] || {};
  const patch = { tokenEnc: await encryptString(d.access_token), expiresAt: Date.now() + (Number(d.expires_in || 14400) - 60) * 1000 };
  if (d.refresh_token) patch.refreshEnc = await encryptString(d.refresh_token);
  await chrome.storage.local.set({ [key]: { ...cur, ...patch } });
}

async function dropboxToken(sink) {
  const key = 'dbx:' + sink.id;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached && cached.expiresAt > Date.now() && cached.tokenEnc) { const t = await decryptString(cached.tokenEnc); if (t) return t; }
  // Refresh token: from a Connect (stored refreshEnc) or the manual/advanced field (refreshRef secret).
  const refresh = cached && cached.refreshEnc ? await decryptString(cached.refreshEnc)
    : (sink.refreshRef ? await getSecret(sink.refreshRef) : null);
  const appKey = dbxAppKey(sink);
  if (!refresh || !appKey) throw new Error('dropbox: not connected — use “Connect Dropbox”');
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: appKey }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('dropbox refresh ' + r.status + ' ' + (d.error_description || d.error || ''));
  await storeDropboxTokens(sink.id, d);
  return d.access_token;
}

// User-initiated "Connect Dropbox": PKCE authorization-code flow via launchWebAuthFlow (no client secret,
// token_access_type=offline → a refresh token for silent-forever renewal). One click; nothing to paste.
// (Firefox: the redirect is a per-install UUID, same caveat as Drive Path B — register it on the app, or
// use the advanced refresh-token field.)
export async function dropboxConnect(sink) {
  const appKey = dbxAppKey(sink);
  if (!appKey) throw new Error('dropbox: no app key configured');
  const verifier = pkceVerifier();
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
    client_id: appKey, response_type: 'code', token_access_type: 'offline',
    code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', redirect_uri: redirectUri,
  });
  const redir = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  const code = new URL(redir).searchParams.get('code');
  if (!code) throw new Error('dropbox: ' + (new URL(redir).searchParams.get('error') || 'no authorization code'));
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: appKey, code_verifier: verifier, redirect_uri: redirectUri }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token || !d.refresh_token) throw new Error('dropbox connect ' + r.status + ' ' + (d.error_description || d.error || ''));
  await storeDropboxTokens(sink.id, d);
  return true;
}
// Connected = we can get a token silently (a stored refresh token, or the advanced refreshRef secret).
export async function dropboxConnected(sink) {
  const cached = (await chrome.storage.local.get('dbx:' + sink.id))['dbx:' + sink.id];
  return !!((cached && cached.refreshEnc) || sink.refreshRef);
}
export async function dropboxDisconnect(sink) { try { await chrome.storage.local.remove('dbx:' + sink.id); } catch (e) {} }
export function dropboxRedirectUri() { try { return chrome.identity.getRedirectURL(); } catch (e) { return ''; } }
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
