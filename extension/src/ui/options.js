import { chrome } from '../lib/ext.js';
import { getConfig, upsert, remove } from '../lib/config.js';
import { setSecret } from '../lib/secrets.js';
import { connectDrive, redirectUri } from '../sinks/drive.js';
import { putHandle } from '../lib/fs.js';
import { sinkAcceptsSource } from '../sinks/format.js';
import { watchThemeIcon } from '../lib/theme-icon.js';
import { applyI18n, t } from '../lib/i18n.js';
import { getAdapters, removeSource, isBuiltinSource } from '../adapters/index.js';
import { needsConsent, hasConsent, grantConsent, consentDescriptor } from '../lib/consent.js';
import { requestCapturePermissions, registerCapture, unregisterCapture } from '../lib/capture.js';
import { exportSource, buildShareUrl, importFromFile } from '../registry/share.js';
import { saveSource } from '../adapters/index.js';
import { editJson } from './jsoneditor.js';
import { getGrants, revokeGrant } from '../lib/grants.js';

let CATALOG = {};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Starting point for "Paste JSON" — a minimal, valid-shaped source to edit or paste over.
const PASTE_TEMPLATE = {
  id: 'my-source', name: 'My source', service: 'service', trust: 'community', domain: 'example.com',
  categories: ['other'], match: ['https://www.example.com/*'],
  auth: { mode: 'cookie', replayHeaders: [] },
  api: { host: 'https://www.example.com', list: { path: '/api/list', paging: 'none', itemsPath: 'items' } },
  fields: { internalId: 'id', number: 'number', date: 'date', total: 'total', storeName: 'store' },
  schema: 'receipt@1',
};

// Mandatory consent screen before a community / cross-domain source is enabled. Dynamic host
// values go in via textContent (never innerHTML) so nothing from a source can inject markup.
function confirmConsent(desc) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999';
    const box = document.createElement('div');
    box.className = 'card';
    box.style.cssText = 'max-width:540px;margin:16px';
    const add = (tag, txt, css, cls) => { const e = document.createElement(tag); if (txt != null) e.textContent = txt; if (css) e.style.cssText = css; if (cls) e.className = cls; box.append(e); return e; };
    add('h3', t('consent_title', [desc.name]));
    add('p', t('consent_reads', [desc.matchHosts.join(', ') || desc.domain]));
    add('p', t('consent_replays', [desc.apiHost || desc.domain]));
    if (desc.crossDomain.length) add('p', t('consent_offsite_warn', [desc.crossDomain.join(', ')]), 'color:#c0392b;font-weight:600;border:1px solid #c0392b;border-radius:8px;padding:8px 10px');
    add('p', `${t(desc.trust === 'first-party' ? 'trust_first_party' : 'trust_community')} · ${desc.categories.join(', ')}`, null, 'muted');
    const row = add('div', null, 'margin-top:14px;justify-content:flex-end;gap:8px', 'row');
    const cancel = document.createElement('button'); cancel.textContent = t('consent_cancel');
    const ok = document.createElement('button'); ok.className = 'primary'; ok.textContent = t('consent_accept');
    row.append(cancel, ok); ov.append(box); document.body.append(ov);
    const done = (v) => { ov.remove(); resolve(v); };
    cancel.onclick = () => done(false); ok.onclick = () => done(true);
    ov.onclick = (e) => { if (e.target === ov) done(false); };
  });
}

async function render() {
  const cfg = await getConfig();
  CATALOG = await getAdapters();

  $('#ds').innerHTML = Object.values(CATALOG).map((a) => {
    const on = cfg.datasources.some((d) => d.id === a.id && d.enabled);
    // Only BUILT-IN sources can carry the audited "first-party" label; a user-imported source is always
    // shown as community and is fully editable/removable (a self-declared trust in its JSON is ignored).
    const builtin = isBuiltinSource(a.id);
    const trust = builtin && a.trust === 'first-party' ? t('trust_first_party') : t('trust_community');
    const editable = !builtin;
    const extra = editable
      ? `<button data-edit="${esc(a.id)}">${t('edit_json')}</button><button data-exp="${a.id}">${t('export_source')}</button><button data-share="${a.id}">${t('share_source')}</button><button data-delsrc="${a.id}">${t('remove')}</button>`
      : '';
    return `<div class="card row"><b style="flex:1">${esc(a.name)}</b><span class="pill type">${trust}</span><code>${esc(a.id)}</code>
      <button data-ds="${esc(a.id)}" data-on="${on ? 1 : 0}" class="${on ? '' : 'primary'}">${on ? t('deactivate') : t('activate')}</button>${extra}</div>`;
  }).join('');
  $('#ds').querySelectorAll('[data-edit]').forEach((b) => b.onclick = async () => {
    const edited = await editJson(CATALOG[b.dataset.edit]);
    if (edited) { await saveSource(edited); render(); }
  });
  $('#ds').querySelectorAll('[data-exp]').forEach((b) => b.onclick = () => exportSource(CATALOG[b.dataset.exp]));
  $('#ds').querySelectorAll('[data-share]').forEach((b) => b.onclick = () => window.open(buildShareUrl(CATALOG[b.dataset.share]), '_blank', 'noopener'));
  $('#ds').querySelectorAll('[data-delsrc]').forEach((b) => b.onclick = async () => {
    await remove('datasources', b.dataset.delsrc);
    await removeSource(b.dataset.delsrc);
    render();
  });
  $('#ds').querySelectorAll('[data-ds]').forEach((b) => b.onclick = async () => {
    if (b.dataset.on === '1') { await unregisterCapture(b.dataset.ds); await remove('datasources', b.dataset.ds); return render(); }
    const adapter = CATALOG[b.dataset.ds];
    if (adapter && needsConsent(adapter) && !(await hasConsent(adapter))) {
      if (!(await confirmConsent(consentDescriptor(adapter)))) return; // declined → do not enable
      await grantConsent(adapter);
    }
    // Grant host permissions + register the in-session capture bridge so the token/DNI is captured on
    // the login site (must be in this user gesture). Non-fatal if declined — cookie sources still work.
    if (adapter) { await requestCapturePermissions(adapter); await registerCapture(adapter); }
    await upsert('datasources', { id: b.dataset.ds, adapter: b.dataset.ds, enabled: true, options: {} });
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
    const dsAdapter = CATALOG[d.adapter];
    const sinks = swSinks.filter((s) => !dsAdapter || sinkAcceptsSource(s, dsAdapter));
    const opts = sinks.map((s) => `<option value="${s.id}" ${route && route.sink === s.id ? 'selected' : ''}>${s.id} (${s.type})</option>`).join('');
    return `<div class="card row"><b style="flex:1">${d.id}</b><span class="muted">→ auto</span>
      <select data-rsel="${d.id}" ${sinks.length ? '' : 'disabled'}>${opts || `<option value="">${t('no_sw_sinks')}</option>`}</select>
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

  const grants = await getGrants();
  $('#grants').innerHTML = grants.length
    ? grants.map((g) => {
      let originHost = g.origin; try { originHost = new URL(g.origin).host; } catch (e) {}
      const used = g.lastUsedAt ? `<span class="muted">${esc(String(g.lastUsedAt).slice(0, 10))}</span>` : '';
      return `<div class="card row"><b style="flex:1">${esc(t('grant_line', [originHost, g.datasourceId]))}</b>${used}<button data-revoke="${esc(g.id)}">${t('grant_revoke')}</button></div>`;
    }).join('')
    : `<p class="muted">${t('no_grants')}</p>`;
  $('#grants').querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => { await revokeGrant(b.dataset.revoke); render(); });
}

function renderFields() {
  const type = $('#stype').value;
  if (type === 'http') {
    $('#sfields').innerHTML = `id:<input id="sid" size="8"> url:<input id="surl" size="22"> token:<input id="stok" size="10"> <label>${t('sink_accepts')}</label><input id="saccepts" size="14" placeholder="grocery,fuel">`;
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
    const acc = (($('#saccepts') && $('#saccepts').value) || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (acc.length) sink.accepts = { categories: acc };
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
if (!window.showDirectoryPicker) {
  const opt = document.querySelector('#stype option[value="local-folder"]');
  if (opt) opt.remove(); // Firefox: no File System Access, hide the local-folder sink
}
$('#stype').onchange = renderFields;
$('#addsink').onclick = addSink;
$('#create').onclick = () => { location.href = 'author.html'; };
$('#browse').onclick = () => { location.href = 'marketplace.html'; };
$('#paste').onclick = async () => {
  const adapter = await editJson(PASTE_TEMPLATE);
  if (adapter) { await saveSource(adapter); render(); }
};
$('#import').onclick = () => $('#importfile').click();
$('#importfile').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const adapter = await importFromFile(file);
    await saveSource(adapter);
    alert(t('import_ok', [adapter.id]));
    render();
  } catch (err) { alert(t('import_err', [err.message])); }
  e.target.value = '';
};
// Four tabs (sources / destinations / auto-sync / site integrations) — keeps Settings short.
(function initTabs() {
  const btns = [...document.querySelectorAll('.tab-btn')];
  const show = (name) => {
    document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.dataset.tab !== name; });
    btns.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    try { localStorage.setItem('habeas-settings-tab', name); } catch (e) {}
  };
  btns.forEach((b) => { b.onclick = () => show(b.dataset.tab); });
  let saved; try { saved = localStorage.getItem('habeas-settings-tab'); } catch (e) {}
  show(btns.some((b) => b.dataset.tab === saved) ? saved : 'sources');
})();

renderFields();
render();
watchThemeIcon();
