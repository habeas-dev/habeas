// Shared "add a destination (sink)" form — used by BOTH Settings (options.js) and the first-run assistant
// (archive.js), so the sink-creation UI + logic lives in ONE place. Renders the per-type fields, reads them into
// a sink object (handling secrets + folder handles), and can OAuth-connect a drive/dropbox sink. No DOM globals:
// everything is scoped to a passed-in root element, so it works inside Settings or a modal alike.
import { upsert } from '../lib/config.js';
import { setSecret } from '../lib/secrets.js';
import { putHandle } from '../lib/fs.js';
import { driveSignIn, driveConnected, redirectUri } from '../sinks/drive.js';
import { dropboxConnect, dropboxConnected, dropboxRedirectUri } from '../sinks/dropbox.js';
import { t } from '../lib/i18n.js';
import { esc } from '../lib/esc.js';

// The destination types offered, in the Settings order. `store` marks the ones that can back the canonical store.
export const SINK_TYPES = [
  { value: 'download', i18n: 'sink_download' },
  { value: 'local-folder', i18n: 'sink_local' },
  { value: 'drive', i18n: 'sink_drive', store: true },
  { value: 'http', i18n: 'sink_http', store: true },
  { value: 'webdav', i18n: 'sink_webdav', store: true },
  { value: 's3', i18n: 'sink_s3', store: true },
  { value: 'dropbox', i18n: 'sink_dropbox', store: true },
];
export const storeCapable = (type) => !!(SINK_TYPES.find((x) => x.value === type) || {}).store;

// The per-type input fields (HTML for the fields container). Moved verbatim from options.js#renderFields.
export function renderSinkFields(type) {
  if (type === 'http') {
    return `id:<input id="sid" size="8"> url:<input id="surl" size="22"> token:<input id="stok" size="10"> <label>${t('sink_accepts')}</label><input id="saccepts" size="14" placeholder="grocery,fuel">`;
  } else if (type === 'webdav') {
    return `id:<input id="sid" size="8"> <label>${t('webdav_url')}</label><input id="surl" size="24" placeholder="https://host/remote.php/dav/files/me/Habeas"> <label>${t('webdav_user')}</label><input id="swuser" size="10"> <label>${t('webdav_pass')}</label><input id="swpass" type="password" size="10">`;
  } else if (type === 's3') {
    return `id:<input id="sid" size="6"> <label>${t('s3_bucket')}</label><input id="s3bucket" size="10"> <label>${t('s3_region')}</label><input id="s3region" size="8" placeholder="us-east-1"> <label>${t('s3_key')}</label><input id="s3ak" size="10"> <label>${t('s3_secret')}</label><input id="s3sk" type="password" size="10"> <label>${t('s3_endpoint_opt')}</label><input id="s3ep" size="16" placeholder="MinIO/R2/B2"> <label>${t('s3_prefix_opt')}</label><input id="s3prefix" size="8">`;
  } else if (type === 'dropbox') {
    return `id:<input id="sid" size="6"> <label>${t('dbx_folder_opt')}</label><input id="dbxfolder" size="12" placeholder="${t('dbx_folder_ph')}"> <label>${t('dbx_appkey_opt')}</label><input id="dbxkey" size="14"> <label>${t('dbx_refresh_opt')}</label><input id="dbxrefresh" type="password" size="16">`
      + `<div style="flex-basis:100%;margin-top:4px"><small>${t('dbx_hint')}</small><br><small>${t('redirect_hint')}</small> <code>${dropboxRedirectUri()}</code></div>`;
  } else if (type === 'drive') {
    return `id:<input id="sid" size="8"> <label>${t('client_id_optional')}</label><input id="sclient" size="26">`
      + `<div style="flex-basis:100%;margin-top:6px"><small>${t('redirect_hint')}</small><br><code>${redirectUri()}</code></div>`;
  }
  return `id:<input id="sid" size="8">`;
}

// Read the mounted fields (scoped to `root`) into a sink object, storing any secret + folder handle. Returns the
// sink, or null when the user cancelled (a folder picker) / the platform can't (File System Access). From addSink.
export async function buildSinkFromForm(root, type) {
  const val = (id) => { const el = root.querySelector('#' + id); return el ? el.value : ''; };
  const id = (val('sid').trim()) || (type + '-1');
  const sink = { id, type };
  if (type === 'http') {
    sink.url = val('surl').trim(); sink.tokenRef = 'secret://' + id;
    if (val('stok').trim()) await setSecret(id, val('stok').trim());
    const acc = (val('saccepts') || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (acc.length) sink.accepts = { categories: acc };
  } else if (type === 'webdav') {
    sink.url = val('surl').trim();
    sink.username = val('swuser').trim() || undefined;
    if (val('swpass')) { sink.passwordRef = 'secret://' + id; await setSecret(id, val('swpass')); }
  } else if (type === 's3') {
    sink.bucket = val('s3bucket').trim();
    sink.region = val('s3region').trim() || 'us-east-1';
    sink.accessKeyId = val('s3ak').trim();
    const ep = val('s3ep').trim(); if (ep) { sink.endpoint = ep; sink.pathStyle = true; }
    const prefix = val('s3prefix').trim(); if (prefix) sink.prefix = prefix;
    if (val('s3sk')) { sink.secretRef = 'secret://' + id; await setSecret(id, val('s3sk')); }
  } else if (type === 'dropbox') {
    sink.appKey = val('dbxkey').trim() || undefined;
    const folder = val('dbxfolder').trim(); if (folder) sink.rootFolderName = folder;
    if (val('dbxrefresh')) { sink.refreshRef = 'secret://' + id; await setSecret(id, val('dbxrefresh').trim()); }
  } else if (type === 'drive') {
    sink.clientId = val('sclient').trim() || undefined;
    sink.rootFolderName = 'Habeas';
  } else if (type === 'local-folder') {
    if (!window.showDirectoryPicker) { alert(t('fs_unsupported')); return null; }
    try { const handle = await window.showDirectoryPicker({ mode: 'readwrite' }); await putHandle('dir:' + id, handle); sink.folderName = handle.name; }
    catch (e) { return null; }
  }
  return sink;
}

// OAuth-connect a drive/dropbox sink (interactive). Other types carry their credentials in the form → no-op.
export async function connectSink(sink) {
  if (!sink) return;
  if (sink.type === 'drive') { await driveSignIn(sink.clientId); return; }
  if (sink.type === 'dropbox') { await dropboxConnect(sink); return; }
}
// Whether a sink already has the credentials it needs to be used right now.
export async function sinkConnected(sink) {
  if (!sink) return false;
  if (sink.type === 'drive') { try { return await driveConnected(sink.clientId); } catch (e) { return false; } }
  if (sink.type === 'dropbox') { try { return await dropboxConnected(sink); } catch (e) { return false; } }
  return true;
}
export const needsConnect = (type) => type === 'drive' || type === 'dropbox';

// Mount the full add-a-destination form (type picker + fields + Add button) into `root`. On Add: build + persist
// the sink, then call opts.onSaved(sink). opts.types limits the offered types; opts.type preselects one.
export function mountSinkForm(root, opts = {}) {
  const allowed = opts.types || SINK_TYPES.map((x) => x.value);
  const wrap = document.createElement('div'); wrap.className = 'row';
  const sel = document.createElement('select');
  sel.innerHTML = SINK_TYPES.filter((x) => allowed.includes(x.value)).map((x) => `<option value="${esc(x.value)}">${esc(t(x.i18n))}</option>`).join('');
  if (opts.type && allowed.includes(opts.type)) sel.value = opts.type;
  const fields = document.createElement('span'); fields.className = 'row';
  const add = document.createElement('button'); add.className = 'primary'; add.textContent = t(opts.addLabel || 'add');
  const paint = () => { fields.innerHTML = renderSinkFields(sel.value); };
  sel.onchange = paint; paint();
  add.onclick = async () => {
    add.disabled = true;
    try {
      const sink = await buildSinkFromForm(wrap, sel.value);
      if (!sink) return;
      await upsert('sinks', sink);
      if (opts.onSaved) await opts.onSaved(sink);
    } catch (e) { if (opts.onError) opts.onError(e); else alert((e && e.message) || String(e)); }
    finally { add.disabled = false; }
  };
  wrap.append(sel, fields, add);
  root.innerHTML = ''; root.append(wrap);
  return { typeSelect: sel, repaint: paint };
}
