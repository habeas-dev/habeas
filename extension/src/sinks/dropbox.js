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
const DEFAULT_DROPBOX_APP_KEY = 'wv89vk62nf0qnad';
const dbxAppKey = (sink) => (sink && sink.appKey) || DEFAULT_DROPBOX_APP_KEY;

// A single, STABLE redirect registered once on the Dropbox app: a static landing page on habeas.dev.
// Browser-extension redirect URLs are per-install (and Firefox rejects a custom one in launchWebAuthFlow),
// so instead the extension opens the flow in a tab and reads the ?code off THIS url (authViaTab). The page
// holds no secret and never sees a token (the code is PKCE-bound). Works uniformly on Chrome AND Firefox
// with nothing to register per user. Overridable per sink for self-hosters.
const DBX_BOUNCE = 'https://habeas.dev/oauth/dropbox.html';
const dbxBounce = (sink) => (sink && sink.oauthRedirect) || DBX_BOUNCE;

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

// Cross-browser OAuth WITHOUT launchWebAuthFlow: open the authorize URL in a tab and read the code off the
// redirect to the (single, stable, registered) habeas.dev bounce. This is required for Firefox — since FF75
// launchWebAuthFlow refuses any redirect_uri other than the per-install getRedirectURL(), which can't be
// pre-registered. Reading tab.url needs host permission for the bounce origin; the optional https://*/*
// grant covers it (requested here in the Connect click gesture if not already granted).
function authViaTab(authUrl, bounce, nonce) {
  return new Promise((resolve, reject) => {
    let tabId = null, done = false;
    const timer = setTimeout(() => finish(() => reject(new Error('dropbox: timed out'))), 180000);
    function finish(cb) {
      if (done) return; done = true;
      clearTimeout(timer);
      try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (e) {}
      try { chrome.tabs.onRemoved.removeListener(onRem); } catch (e) {}
      if (tabId != null) { try { chrome.tabs.remove(tabId); } catch (e) {} }
      cb();
    }
    const onUpd = (id, info, tab) => {
      if (id !== tabId || !tab || !tab.url || tab.url.indexOf(bounce) !== 0) return; // wait for the bounce redirect
      let u; try { u = new URL(tab.url); } catch (e) { return; }
      const err = u.searchParams.get('error_description') || u.searchParams.get('error');
      if (err) return finish(() => reject(new Error('dropbox: ' + err)));
      if (u.searchParams.get('state') !== nonce) return; // not our redirect (CSRF guard)
      const code = u.searchParams.get('code');
      if (code) finish(() => resolve(code));
    };
    const onRem = (id) => { if (id === tabId) finish(() => reject(new Error('dropbox: window closed'))); };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.onRemoved.addListener(onRem);
    chrome.tabs.create({ url: authUrl, active: true }).then((t) => { tabId = t.id; }, (e) => finish(() => reject(e)));
  });
}

export async function dropboxConnect(sink) {
  const appKey = dbxAppKey(sink);
  if (!appKey) throw new Error('dropbox: no app key configured');
  const bounce = dbxBounce(sink);
  try { await chrome.permissions.request({ origins: [new URL(bounce).origin + '/*'] }); } catch (e) {} // to read tab.url
  const verifier = pkceVerifier();
  const nonce = pkceVerifier().slice(0, 24);
  const authUrl = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
    client_id: appKey, response_type: 'code', token_access_type: 'offline',
    // Request the scopes we actually use, explicitly. list_folder needs files.metadata.read; sink delivery
    // needs files.content.write; the canonical STORE-on-Dropbox back-end reads its JSON back via
    // files/download → files.content.read (WITHOUT it, download 401s "app not permitted to access this
    // endpoint" while list/upload still work). The scopes must ALSO be enabled on the Dropbox app itself
    // (App Console → Permissions); a refresh token minted before a scope was granted lacks it → reconnect.
    scope: 'files.metadata.read files.content.write files.content.read',
    code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', redirect_uri: bounce, state: nonce,
  });
  const code = await authViaTab(authUrl, bounce, nonce);
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: appKey, code_verifier: verifier, redirect_uri: bounce }) });
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
export function dropboxRedirectUri() { return DBX_BOUNCE; } // the single stable redirect to register on the app
async function dbxUpload(token, path, blob) {
  const r = await fetch(UPLOAD_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': apiArg({ path, mode: 'overwrite', mute: true }), 'Content-Type': 'application/octet-stream' }, body: blob });
  if (!r.ok) throw new Error('dropbox upload ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120));
}
async function dbxDownloadJson(token, path) {
  const r = await fetch(DOWNLOAD_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': apiArg({ path }) } });
  if (r.status === 409) return []; // path/not_found → no manifest yet
  if (!r.ok) throw new Error(`Dropbox download ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`); // e.g. 401 missing files.content.read
  return await r.json().catch(() => []);
}

export async function dropboxWrite(sink, docs, files, opts = {}) {
  const token = await dropboxToken(sink);
  // Default root is EMPTY: the shipped app is a Dropbox "App folder" type, so Dropbox already scopes
  // everything under Aplicaciones/<app>/ — adding our own 'Habeas' on top would nest a redundant Habeas/.
  const root = sink.rootFolderName || '';
  const service = opts.service || 'documents';
  let n = 0;
  for (const d of docs) for (const art of files.get(d.internalId) || []) { await dbxUpload(token, dbxPath(root, pathFor(sink, d, opts, art.ext)), art.blob); n++; }
  const mfPath = dbxPath(root, service + '/' + mfName(opts));
  // The manifest is CUMULATIVE (read existing → merge → write). If we can't READ it (e.g. the app lacks the
  // files.content.read scope), do NOT overwrite it with only this batch — that would erase history. Deliver
  // the files and leave the manifest untouched; surface the reason so the user can fix the Dropbox scope.
  let prev;
  try { prev = await dbxDownloadJson(token, mfPath); }
  catch (e) { return { written: n, total: docs.length, manifestSkipped: (e && e.message) || String(e) }; }
  await dbxUpload(token, mfPath, jsonBlob(JSON.stringify(mergeRecords(prev, toRecords(docs, files)), null, 2)));
  return { written: n, total: docs.length };
}

// Retrieve a previously-delivered artifact (relative path under the sink root) as a Blob, for the in-app
// document viewer. null if the file isn't there (409). Needs files.content.read (same scope as store read).
export async function dropboxRetrieve(sink, relPath) {
  const token = await dropboxToken(sink);
  const path = dbxPath(sink.rootFolderName || '', relPath);
  const r = await fetch(DOWNLOAD_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': apiArg({ path }) } });
  if (r.status === 409) return null;
  if (!r.ok) throw new Error(`Dropbox download ${r.status}`);
  return await r.blob();
}

// Canonical-store backend on Dropbox: per-source JSON at <root>/<storeFolder>/<sourceId>.json, reusing the
// sink's token. All ops are best-effort/silent — a store read/write must never break a List or delivery.
export function dropboxStore(sink, cfg = {}) {
  const folder = dbxPath(sink.rootFolderName || '', (cfg && cfg.storeFolder) || '_store');
  const filePath = (id) => folder + '/' + id + '.json';
  return {
    async loadSource(id) {
      const token = await dropboxToken(sink);
      const r = await fetch(DOWNLOAD_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': apiArg({ path: filePath(id) }) } });
      // 409 = path/not_found → genuinely no store entry yet (return null, not an error). Any OTHER non-ok
      // status (401 token, 5xx…) is a real failure the caller must SEE — don't collapse it to "empty".
      if (r.status === 409) return null;
      if (!r.ok) throw new Error(`Dropbox download ${r.status} for ${filePath(id)}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      const j = await r.json().catch(() => null);
      if (!j || typeof j !== 'object' || Array.isArray(j) || !j.items) throw new Error(`Dropbox store file ${filePath(id)} exists but is not a valid store object (no .items)`);
      return j;
    },
    async saveSource(id, data) {
      try { await dbxUpload(await dropboxToken(sink), filePath(id), jsonBlob(JSON.stringify(data))); } catch (e) { /* best-effort */ }
    },
    async listSources() {
      try {
        const token = await dropboxToken(sink);
        const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: folder }) });
        if (!r.ok) return [];
        const j = await r.json().catch(() => ({}));
        return (j.entries || []).filter((e) => e['.tag'] === 'file' && /\.json$/.test(e.name || '')).map((e) => e.name.replace(/\.json$/, ''));
      } catch (e) { return []; }
    },
  };
}
