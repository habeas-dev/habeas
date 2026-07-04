import { chrome } from '../lib/ext.js';
import { getConfig, upsert, remove } from '../lib/config.js';
import { setSecret } from '../lib/secrets.js';
import { connectDrive, redirectUri } from '../sinks/drive.js';
import { putHandle } from '../lib/fs.js';
import { watchThemeIcon } from '../lib/theme-icon.js';
import { applyI18n, t } from '../lib/i18n.js';
import CARREFOUR from '../adapters/carrefour-es.js';

const CATALOG = { 'carrefour-es': CARREFOUR };
const $ = (s) => document.querySelector(s);

async function render() {
  const cfg = await getConfig();

  $('#ds').innerHTML = Object.values(CATALOG).map((a) => {
    const on = cfg.datasources.some((d) => d.id === a.id && d.enabled);
    return `<div class="card row"><b style="flex:1">${a.name}</b><code>${a.id}</code>
      <button data-ds="${a.id}" data-on="${on ? 1 : 0}" class="${on ? '' : 'primary'}">${on ? t('deactivate') : t('activate')}</button></div>`;
  }).join('');
  $('#ds').querySelectorAll('[data-ds]').forEach((b) => b.onclick = async () => {
    if (b.dataset.on === '1') await remove('datasources', b.dataset.ds);
    else await upsert('datasources', { id: b.dataset.ds, adapter: b.dataset.ds, enabled: true, options: {} });
    render();
  });

  $('#sinks').innerHTML = cfg.sinks.map((s) =>
    `<div class="card row"><b style="flex:1">${s.id}</b><code>${s.type}</code>
      ${s.type === 'drive' ? `<button data-conn="${s.id}">${t('connect_drive')}</button>` : ''}
      ${s.type === 'local-folder' ? `<code>${s.folderName || '—'}</code><button data-folder="${s.id}">${t('change_folder')}</button>` : ''}
      ${s.url ? `<small>${s.url}</small>` : ''}
      <button data-del="${s.id}">${t('remove')}</button></div>`).join('')
    || `<p class="muted">${t('no_sinks')}</p>`;
  $('#sinks').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { await remove('sinks', b.dataset.del); render(); });
  $('#sinks').querySelectorAll('[data-folder]').forEach((b) => b.onclick = async () => {
    if (!window.showDirectoryPicker) { alert(t('fs_unsupported')); return; }
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await putHandle('dir:' + b.dataset.folder, handle);
      const s = (await getConfig()).sinks.find((x) => x.id === b.dataset.folder);
      if (s) { s.folderName = handle.name; await upsert('sinks', s); }
      render();
    } catch (e) { /* cancelled */ }
  });
  $('#sinks').querySelectorAll('[data-conn]').forEach((b) => b.onclick = async () => {
    const s = (await getConfig()).sinks.find((x) => x.id === b.dataset.conn);
    b.disabled = true; b.textContent = t('connecting');
    try { await connectDrive(s.clientId); b.textContent = '✓ ' + t('connected'); }
    catch (e) { b.textContent = t('connect_drive'); alert('Drive: ' + e.message); }
    finally { b.disabled = false; }
  });

  const swSinks = cfg.sinks.filter((s) => s.type === 'drive' || s.type === 'http');
  $('#routes').innerHTML = cfg.datasources.filter((d) => d.enabled).map((d) => {
    const route = (cfg.routes || []).find((r) => r.datasource === d.id && r.mode === 'auto');
    const opts = swSinks.map((s) => `<option value="${s.id}" ${route && route.sink === s.id ? 'selected' : ''}>${s.id} (${s.type})</option>`).join('');
    return `<div class="card row"><b style="flex:1">${d.id}</b><span class="muted">→ auto</span>
      <select data-rsel="${d.id}" ${swSinks.length ? '' : 'disabled'}>${opts || `<option value="">${t('no_sw_sinks')}</option>`}</select>
      <button data-rtoggle="${d.id}" data-on="${route ? 1 : 0}" class="${route ? '' : 'primary'}">${route ? t('disable_auto') : t('enable_auto')}</button></div>`;
  }).join('') || `<p class="muted">${t('enable_ds_first')}</p>`;
  $('#routes').querySelectorAll('[data-rtoggle]').forEach((b) => b.onclick = async () => {
    const dsId = b.dataset.rtoggle;
    const existing = ((await getConfig()).routes || []).find((r) => r.datasource === dsId && r.mode === 'auto');
    if (existing) { await remove('routes', existing.id); }
    else {
      const sel = document.querySelector(`[data-rsel="${dsId}"]`);
      const sinkId = sel && sel.value;
      if (!sinkId) { alert(t('add_sink_first')); return; }
      await upsert('routes', { id: dsId + '->' + sinkId, datasource: dsId, sink: sinkId, mode: 'auto' });
    }
    render();
  });
}

function renderFields() {
  const type = $('#stype').value;
  if (type === 'http') {
    $('#sfields').innerHTML = `id:<input id="sid" size="8"> url:<input id="surl" size="24"> token:<input id="stok" size="12">`;
  } else if (type === 'drive') {
    $('#sfields').innerHTML = `id:<input id="sid" size="8"> <label>${t('client_id_optional')}</label><input id="sclient" size="26">`
      + `<div style="flex-basis:100%;margin-top:6px"><small>${t('redirect_hint')}</small><br><code>${redirectUri()}</code></div>`;
  } else {
    $('#sfields').innerHTML = `id:<input id="sid" size="8">`;
  }
}

async function addSink() {
  const type = $('#stype').value;
  const id = ($('#sid') && $('#sid').value.trim()) || (type + '-1');
  const sink = { id, type };
  if (type === 'http') {
    sink.url = ($('#surl').value || '').trim();
    sink.tokenRef = 'secret://' + id;
    if ($('#stok').value.trim()) await setSecret(id, $('#stok').value.trim());
  } else if (type === 'drive') {
    sink.clientId = ($('#sclient').value || '').trim() || undefined;
    sink.rootFolderName = 'Habeas';
  } else if (type === 'local-folder') {
    if (!window.showDirectoryPicker) { alert(t('fs_unsupported')); return; }
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await putHandle('dir:' + id, handle);
      sink.folderName = handle.name;
    } catch (e) { return; }
  }
  await upsert('sinks', sink);
  renderFields();
  render();
}

applyI18n();
$('#stype').onchange = renderFields;
$('#addsink').onclick = addSink;
renderFields();
render();
watchThemeIcon();
