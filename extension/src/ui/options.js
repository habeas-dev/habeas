import { chrome } from '../lib/ext.js';
import { getConfig, saveConfig, upsert, remove } from '../lib/config.js';
import { setSecret } from '../lib/secrets.js';
import { driveSignIn, redirectUri, driveConnected, disconnectDrive, preferDeviceFlow, driveDeviceConnect } from '../sinks/drive.js';
import { dropboxConnect, dropboxRedirectUri } from '../sinks/dropbox.js';
import { putHandle, getHandle, verifyPermission } from '../lib/fs.js';
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
import { getStoreConfig, moveStoreTo, putItems } from '../lib/store.js';
import { readSinkRecords } from '../sinks/sinks.js';
import { esc } from '../lib/esc.js';
import { nextOccurrence, describeSchedule, validateSpec } from '../lib/schedule.js';
import { getSubmitter, markSeen, unreadCount } from '../lib/submitter.js';
import { getMyHandoffs, getHandoffThread, replyHandoff } from '../registry/client.js';

let CATALOG = {};
const $ = (s) => document.querySelector(s);
const flag = (code) => !code ? '' : code === 'global' ? '🌐' : (/^[A-Za-z]{2}$/.test(code) ? code.toUpperCase().replace(/./g, (c) => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)) : '');

// Live client-side filter of a .src-card list by its search box (matches each card's data-hay).
function filterList(listSel, inputSel, emptySel) {
  const inp = $(inputSel); const q = ((inp && inp.value) || '').trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll(listSel + ' .src-card').forEach((c) => { const vis = !q || c.dataset.hay.includes(q); c.hidden = !vis; if (vis) shown++; });
  const empty = $(emptySel); if (empty) empty.hidden = shown > 0;
}
const filterSources = () => filterList('#ds', '#ds-search', '#ds-empty');
const filterRoutes = () => filterList('#routes', '#auto-search', '#auto-empty');

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

  const isOn = (a) => cfg.datasources.some((d) => d.id === a.id && d.enabled);
  // Order: enabled sources first, then alphabetically by name — so the list is scannable, not random.
  const sources = Object.values(CATALOG).sort((a, b) => (isOn(b) - isOn(a)) || (a.name || a.id).localeCompare(b.name || b.id));
  $('#ds').innerHTML = sources.map((a) => {
    const on = isOn(a);
    // Only BUILT-IN sources can carry the audited "first-party" label; a user-imported source is always
    // shown as community and is fully editable/removable (a self-declared trust in its JSON is ignored).
    const builtin = isBuiltinSource(a.id);
    const trust = builtin && a.trust === 'first-party' ? t('trust_first_party') : t('trust_community');
    const cats = (a.categories || []).join(', ');
    const hay = [a.name, a.id, a.service, a.domain, cats].join(' ').toLowerCase();
    const manage = builtin ? '' : `<div class="src-manage">`
      + `<button class="link" data-edit="${esc(a.id)}">${t('edit_json')}</button>`
      + `<button class="link" data-exp="${esc(a.id)}">${t('export_source')}</button>`
      + `<button class="link" data-share="${esc(a.id)}">${t('share_source')}</button>`
      + `<button class="link danger" data-delsrc="${esc(a.id)}">${t('remove')}</button></div>`;
    return `<div class="src-card${on ? ' on' : ''}" data-hay="${esc(hay)}">
      <div class="src-info">
        <div class="src-title"><b>${esc(a.name)}</b> <span class="pill type">${trust}</span></div>
        <div class="src-meta muted">${a.country ? flag(a.country) + ' ' : ''}${cats ? esc(cats) + ' · ' : ''}<code>${esc(a.id)}</code>${a.version ? ` · <span class="ver">v${esc(String(a.version))}</span>` : ''}</div>
      </div>
      <div class="src-actions">
        <button data-ds="${esc(a.id)}" data-on="${on ? 1 : 0}" class="${on ? '' : 'primary'}">${on ? t('deactivate') : t('activate')}</button>
        ${manage}
      </div>
    </div>`;
  }).join('');
  filterSources();
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

  const defSink = (await chrome.storage.local.get('habeas:defaultsink'))['habeas:defaultsink'] || '';
  $('#sinks').innerHTML = cfg.sinks.map((s) =>
    `<div class="card row"><b style="flex:1">${esc(s.id)}${s.id === defSink ? ' <span class="pill sent">★ ' + t('default_sink') + '</span>' : ''}</b><code>${esc(s.type)}</code>
      ${s.type === 'drive' ? `<button data-conn="${esc(s.id)}">${t('connect_drive')}</button>` : ''}
      ${s.type === 'dropbox' ? `<button data-dbxconn="${esc(s.id)}">${t('connect_dropbox')}</button>` : ''}
      ${s.type === 'local-folder' ? `<code>${esc(s.folderName || '—')}</code><button data-folder="${esc(s.id)}">${t('change_folder')}</button>` : ''}
      ${s.url ? `<small>${esc(s.url)}</small>` : ''}
      <button data-default="${esc(s.id)}" title="${t('set_default_hint')}">${s.id === defSink ? t('unset_default') : t('set_default')}</button>
      <button data-del="${esc(s.id)}">${t('remove')}</button></div>`).join('')
    || `<p class="muted">${t('no_sinks')}</p>`;
  $('#sinks').querySelectorAll('[data-default]').forEach((b) => b.onclick = async () => {
    const cur = (await chrome.storage.local.get('habeas:defaultsink'))['habeas:defaultsink'] || '';
    await chrome.storage.local.set({ 'habeas:defaultsink': cur === b.dataset.default ? '' : b.dataset.default }); // toggle
    render();
  });
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
    try {
      // Firefox with a device client → device flow (no redirect to register). Open the verification page
      // and show the code; the call resolves once the user authorizes there. Else Path A/B via driveSignIn.
      if (preferDeviceFlow()) {
        await driveDeviceConnect(s.clientId, (dc) => {
          try { chrome.tabs.create({ url: dc.verification_url_complete || dc.verification_url }); } catch (e) {}
          b.textContent = t('device_enter_code', [dc.user_code]);
        });
      } else {
        await driveSignIn(s.clientId);
      }
      b.textContent = '✓ ' + t('connected');
    } catch (e) { b.textContent = t('connect_drive'); alert('Drive: ' + e.message); }
    finally { b.disabled = false; }
  });
  $('#sinks').querySelectorAll('[data-dbxconn]').forEach((b) => b.onclick = async () => {
    const s = (await getConfig()).sinks.find((x) => x.id === b.dataset.dbxconn);
    b.disabled = true; b.textContent = t('connecting');
    try { await dropboxConnect(s); b.textContent = '✓ ' + t('connected'); }
    catch (e) { b.textContent = t('connect_dropbox'); alert('Dropbox: ' + e.message); }
    finally { b.disabled = false; }
  });

  const swSinks = cfg.sinks.filter((s) => ['drive', 'http', 'webdav', 's3', 'dropbox'].includes(s.type));
  const enabledDs = cfg.datasources.filter((d) => d.enabled);
  const routeOf = (d) => (cfg.routes || []).find((r) => r.datasource === d.id && r.mode === 'auto');
  const nameOf = (d) => (CATALOG[d.adapter] && CATALOG[d.adapter].name) || d.id;
  // Order: sources with auto enabled first, then alphabetical — same as the Sources tab.
  const ordered = enabledDs.slice().sort((a, b) => ((!!routeOf(b)) - (!!routeOf(a))) || nameOf(a).localeCompare(nameOf(b)));
  $('#routes').innerHTML = ordered.map((d) => {
    const route = routeOf(d);
    const dsAdapter = CATALOG[d.adapter];
    const sinks = swSinks.filter((s) => !dsAdapter || sinkAcceptsSource(s, dsAdapter));
    const opts = sinks.map((s) => `<option value="${esc(s.id)}" ${route && route.sink === s.id ? 'selected' : ''}>${esc(s.id)} (${esc(s.type)})</option>`).join('');
    const hay = [nameOf(d), d.id].join(' ').toLowerCase();
    return `<div class="src-card${route ? ' on' : ''}" data-hay="${esc(hay)}">
      <div class="src-info">
        <div class="src-title"><b>${esc(nameOf(d))}</b> ${route ? `<span class="pill sent">${t('auto_on_pill')}</span>` : ''}</div>
        <div class="src-meta muted">${route ? '→ ' + esc(route.sink) : `<code>${esc(d.id)}</code>`}</div>
      </div>
      <div class="src-actions">
        <select data-rsel="${esc(d.id)}" ${sinks.length ? '' : 'disabled'}>${opts || `<option value="">${t('no_sw_sinks')}</option>`}</select>
        <button data-rtoggle="${esc(d.id)}" data-on="${route ? 1 : 0}" class="${route ? '' : 'primary'}">${route ? t('disable_auto') : t('enable_auto')}</button>
      </div>
    </div>`;
  }).join('') || `<p class="muted">${t('enable_ds_first')}</p>`;
  filterRoutes();
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
  await renderPlanner(cfg);
}

// ---- Download planner UI ----------------------------------------------------------------------------
const WEEKDAYS = [[1, 'sched_mon'], [2, 'sched_tue'], [3, 'sched_wed'], [4, 'sched_thu'], [5, 'sched_fri'], [6, 'sched_sat'], [7, 'sched_sun']];
// Read the schedule spec from the form's currently-visible fields.
function readSpec() {
  const kind = $('#pl-kind').value, time = $('#pl-time').value;
  if (kind === 'weekly') return { kind, time, weekdays: [...$('#pl-weekdays').querySelectorAll('input:checked')].map((c) => Number(c.value)) };
  if (kind === 'monthly-day') return { kind, time, days: ($('#pl-days').value.match(/\d+/g) || []).map(Number).filter((n) => n >= 1 && n <= 31) };
  if (kind === 'monthly-weekday') return { kind, time, nth: Number($('#pl-nth').value), weekday: Number($('#pl-weekday').value) };
  if (kind === 'monthly-businessday') return { kind, time, nth: Number($('#pl-nth').value) };
  return { kind: 'daily', time };
}
// Show only the fields relevant to the chosen kind + refresh the live preview.
function syncPlannerForm() {
  const kind = $('#pl-kind').value;
  $('#pl-weekdays').hidden = kind !== 'weekly';
  $('#pl-days').hidden = kind !== 'monthly-day';
  $('#pl-nth').hidden = !(kind === 'monthly-weekday' || kind === 'monthly-businessday');
  $('#pl-weekday').hidden = kind !== 'monthly-weekday';
  const spec = readSpec(); const v = validateSpec(spec);
  const nx = v.ok ? nextOccurrence(spec, Date.now()) : null;
  $('#pl-preview').textContent = v.ok ? describeSchedule(spec, t) + (nx ? ' · ' + t('sched_next', [new Date(nx).toLocaleString()]) : '') : '';
  $('#pl-add').disabled = !(v.ok && $('#pl-ds').value && $('#pl-sink').value);
}
async function renderPlanner(cfg) {
  cfg = cfg || (await getConfig());
  const adapters = CATALOG;
  // Only enabled sources, and destinations a schedule can run unattended (not download / not local folder —
  // those need a user click / a live picker). folder is fine (a directory handle persists).
  const dsList = (cfg.datasources || []).filter((d) => d.enabled);
  // Unattended-runnable destinations only: download needs a click; local-folder needs a user gesture to
  // (re)grant File System Access. Cloud sinks (drive/dropbox/webdav/s3) + http run in the background.
  const sinkList = (cfg.sinks || []).filter((s) => s.type !== 'download' && s.type !== 'local-folder');
  const opt = (v, label, sel) => `<option value="${esc(v)}"${sel === v ? ' selected' : ''}>${esc(label)}</option>`;
  const dsSel = $('#pl-ds'), sinkSel = $('#pl-sink');
  if (dsSel) dsSel.innerHTML = dsList.map((d) => opt(d.id, (adapters[d.adapter] && adapters[d.adapter].name) || d.adapter, dsSel.value)).join('') || opt('', t('sched_no_sources'));
  if (sinkSel) sinkSel.innerHTML = sinkList.map((s) => opt(s.id, `${s.id} (${s.type})`, sinkSel.value)).join('') || opt('', t('sched_no_sinks'));
  const wd = $('#pl-weekdays'); if (wd && !wd.dataset.built) { wd.dataset.built = '1'; wd.innerHTML = WEEKDAYS.map(([n, k]) => `<label class="pill" style="cursor:pointer">${esc(t(k))}<input type="checkbox" value="${n}" style="margin-left:3px"></label>`).join(''); }
  const wdSel = $('#pl-weekday'); if (wdSel && !wdSel.options.length) wdSel.innerHTML = WEEKDAYS.map(([n, k]) => `<option value="${n}">${esc(t(k))}</option>`).join('');
  syncPlannerForm();

  const schedules = cfg.schedules || [];
  $('#pl-empty').hidden = schedules.length > 0;
  $('#pl-list').innerHTML = schedules.map((s) => {
    const dsName = (adapters[(dsList.find((d) => d.id === s.datasource) || {}).adapter] || {}).name || s.datasource;
    const nx = s.enabled ? nextOccurrence(s.spec, Date.now()) : null;
    return `<div class="src-card${s.enabled ? ' on' : ''}">
      <div class="src-info">
        <div class="src-title"><b>${esc(dsName)}</b> <span class="muted">→ ${esc(s.sink)}</span></div>
        <div class="src-meta muted">${esc(describeSchedule(s.spec, t))}${nx ? ' · ' + esc(t('sched_next', [new Date(nx).toLocaleString()])) : ''}</div>
      </div>
      <div class="src-actions">
        <button data-pl-toggle="${esc(s.id)}">${s.enabled ? t('deactivate') : t('activate')}</button>
        <button data-pl-run="${esc(s.id)}" title="${t('sched_run_now')}">${t('sched_run_now')}</button>
        <button class="link danger" data-pl-del="${esc(s.id)}">${t('remove')}</button>
      </div></div>`;
  }).join('');
  $('#pl-list').querySelectorAll('[data-pl-toggle]').forEach((b) => b.onclick = async () => { const c = await getConfig(); const s = (c.schedules || []).find((x) => x.id === b.dataset.plToggle); if (s) { s.enabled = !s.enabled; await saveConfig(c); render(); } });
  $('#pl-list').querySelectorAll('[data-pl-del]').forEach((b) => b.onclick = async () => { await remove('schedules', b.dataset.plDel); render(); });
  $('#pl-list').querySelectorAll('[data-pl-run]').forEach((b) => b.onclick = () => { chrome.runtime.sendMessage({ type: 'habeas:sched-run', id: b.dataset.plRun }); b.textContent = t('sched_running'); });
}

function renderFields() {
  const type = $('#stype').value;
  if (type === 'http') {
    $('#sfields').innerHTML = `id:<input id="sid" size="8"> url:<input id="surl" size="22"> token:<input id="stok" size="10"> <label>${t('sink_accepts')}</label><input id="saccepts" size="14" placeholder="grocery,fuel">`;
  } else if (type === 'webdav') {
    $('#sfields').innerHTML = `id:<input id="sid" size="8"> <label>${t('webdav_url')}</label><input id="surl" size="24" placeholder="https://host/remote.php/dav/files/me/Habeas"> <label>${t('webdav_user')}</label><input id="swuser" size="10"> <label>${t('webdav_pass')}</label><input id="swpass" type="password" size="10">`;
  } else if (type === 's3') {
    $('#sfields').innerHTML = `id:<input id="sid" size="6"> <label>${t('s3_bucket')}</label><input id="s3bucket" size="10"> <label>${t('s3_region')}</label><input id="s3region" size="8" placeholder="us-east-1"> <label>${t('s3_key')}</label><input id="s3ak" size="10"> <label>${t('s3_secret')}</label><input id="s3sk" type="password" size="10"> <label>${t('s3_endpoint_opt')}</label><input id="s3ep" size="16" placeholder="MinIO/R2/B2"> <label>${t('s3_prefix_opt')}</label><input id="s3prefix" size="8">`;
  } else if (type === 'dropbox') {
    $('#sfields').innerHTML = `id:<input id="sid" size="6"> <label>${t('dbx_folder_opt')}</label><input id="dbxfolder" size="12" placeholder="${t('dbx_folder_ph')}"> <label>${t('dbx_appkey_opt')}</label><input id="dbxkey" size="14"> <label>${t('dbx_refresh_opt')}</label><input id="dbxrefresh" type="password" size="16">`
      + `<div style="flex-basis:100%;margin-top:4px"><small>${t('dbx_hint')}</small><br><small>${t('redirect_hint')}</small> <code>${dropboxRedirectUri()}</code></div>`;
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
  } else if (type === 'webdav') {
    sink.url = ($('#surl').value || '').trim();
    sink.username = ($('#swuser').value || '').trim() || undefined;
    if ($('#swpass').value) { sink.passwordRef = 'secret://' + id; await setSecret(id, $('#swpass').value); }
  } else if (type === 's3') {
    sink.bucket = ($('#s3bucket').value || '').trim();
    sink.region = ($('#s3region').value || '').trim() || 'us-east-1';
    sink.accessKeyId = ($('#s3ak').value || '').trim();
    const ep = ($('#s3ep').value || '').trim(); if (ep) { sink.endpoint = ep; sink.pathStyle = true; }
    const prefix = ($('#s3prefix').value || '').trim(); if (prefix) sink.prefix = prefix;
    if ($('#s3sk').value) { sink.secretRef = 'secret://' + id; await setSecret(id, $('#s3sk').value); }
  } else if (type === 'dropbox') {
    sink.appKey = ($('#dbxkey').value || '').trim() || undefined;
    const folder = ($('#dbxfolder').value || '').trim(); // blank → the app folder root (App-folder app already scopes under Aplicaciones/<app>/)
    if (folder) sink.rootFolderName = folder;
    if ($('#dbxrefresh').value) { sink.refreshRef = 'secret://' + id; await setSecret(id, $('#dbxrefresh').value.trim()); }
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

// --- Canonical store: where the store lives + moving it between backends (canonical-store.md) -----------
function renderStoreFields() {
  const b = $('#store-backend').value; const f = $('#store-fields'); f.innerHTML = '';
  if (b === 'http') { const i = document.createElement('input'); i.id = 'store-url'; i.type = 'url'; i.placeholder = 'https://…'; i.size = 24; f.append(i); getStoreConfig().then((c) => { if (c.backend === 'http') i.value = c.url || ''; }); }
  else if (b === 'folder') { const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = t('store_pick_folder'); btn.onclick = pickStoreFolder; f.append(btn); }
  else if (b === 'drive') { const btn = document.createElement('button'); btn.type = 'button'; f.append(btn); paintDriveBtn(btn); }
  else if (b === 'dropbox' || b === 'webdav' || b === 's3') {
    // Reuse a configured sink of the same type (its credentials) as the store backend.
    const sel = document.createElement('select'); sel.id = 'store-sink'; f.append(sel);
    getConfig().then(async (c) => {
      const sinks = (c.sinks || []).filter((s) => s.type === b);
      sel.innerHTML = sinks.length ? sinks.map((s) => `<option value="${esc(s.id)}">${esc(s.id)}</option>`).join('') : `<option value="">${t('store_no_sink')}</option>`;
      const cur = await getStoreConfig(); if (cur.backend === b && cur.sinkId) sel.value = cur.sinkId;
    });
  }
}
// Reflect the current Drive connection: "Connect Drive" when not connected, "Disconnect Drive" when it is.
async function paintDriveBtn(btn) {
  const on = await driveConnected();
  btn.textContent = on ? t('drive_disconnect') : t('connect_drive');
  btn.onclick = on ? disconnectStoreDrive : connectStoreDrive;
}
async function connectStoreDrive() {
  // Pre-authorize (drive.file scope) so Move doesn't have to trigger the OAuth popup mid-migration.
  try { await driveSignIn(); $('#store-status').textContent = t('store_folder_ok'); }
  catch (e) { $('#store-status').textContent = t('store_move_err', [(e && e.message) || String(e)]); }
  renderStoreFields(); // repaint → button becomes "Disconnect Drive"
}
async function disconnectStoreDrive() {
  await disconnectDrive();
  $('#store-status').textContent = t('drive_disconnected');
  renderStoreFields();
}
async function pickStoreFolder() {
  try { const h = await window.showDirectoryPicker(); await putHandle('store-dir:canon', h); $('#store-status').textContent = t('store_folder_ok'); }
  catch (e) { /* cancelled */ }
}
async function moveStore() {
  const b = $('#store-backend').value; const cfg = { backend: b };
  if (b === 'http') { cfg.url = ($('#store-url') && $('#store-url').value || '').trim(); if (!cfg.url) { $('#store-status').textContent = t('store_need_url'); return; } }
  if (b === 'folder') cfg.id = 'canon';
  if (b === 'dropbox' || b === 'webdav' || b === 's3') { cfg.sinkId = ($('#store-sink') && $('#store-sink').value) || ''; if (!cfg.sinkId) { $('#store-status').textContent = t('store_need_sink'); return; } }
  // Drive store ops are silent (never surprise-prompt). Move IS a deliberate user action, so ensure a token
  // interactively here (once) — after this the cached token is reused silently for all store writes.
  if (b === 'drive' && !(await driveConnected())) { try { await driveSignIn(); } catch (e) { $('#store-status').textContent = t('store_move_err', [(e && e.message) || String(e)]); return; } }
  $('#store-status').textContent = t('store_moving');
  try { const n = await moveStoreTo(cfg); $('#store-status').textContent = t('store_moved', [String(n)]); }
  catch (e) { $('#store-status').textContent = t('store_move_err', [(e && e.message) || String(e)]); }
}
async function renderStore() {
  $('#store-backend').value = (await getStoreConfig()).backend || 'local'; renderStoreFields();
  // Populate the "import from" list with store-capable, readable sinks (folder/Drive hold delivered records).
  const readable = (await getConfig()).sinks.filter((s) => s.type === 'local-folder' || s.type === 'drive');
  const sel = $('#store-import-sink');
  if (sel) { sel.innerHTML = readable.map((s) => `<option value="${esc(s.id)}">${esc(s.id)} (${esc(s.type)})</option>`).join('') || `<option value="">—</option>`; $('#store-import').disabled = !readable.length; }
}

// Rehydrate the canonical store from a sink's already-delivered records — so existing data lands in the
// store WITHOUT re-extracting from the service (the "read a sink back" recovery path).
async function importFromSink() {
  const cfg = await getConfig();
  const sink = cfg.sinks.find((s) => s.id === $('#store-import-sink').value); if (!sink) return;
  const opts0 = {};
  if (sink.type === 'local-folder') { const h = await getHandle('dir:' + sink.id); if (!h || !(await verifyPermission(h))) { $('#store-import-status').textContent = t('folder_denied'); return; } opts0.dirHandle = h; }
  $('#store-import-status').textContent = t('store_importing');
  let total = 0;
  try {
    for (const ds of cfg.datasources) {
      const adapter = CATALOG[ds.adapter]; if (!adapter) continue;
      let recs; try { recs = await readSinkRecords(sink, { ...opts0, service: adapter.service || ds.adapter, source: adapter.id }); } catch (e) { continue; }
      const items = (recs || []).filter((r) => r && r.internalId != null).map((r) => ({ internalId: r.internalId, record: r }));
      if (items.length) { await putItems(adapter.id, items, { source: adapter.id, schema: adapter.schema }); total += items.length; }
    }
    $('#store-import-status').textContent = t('store_imported', [String(total)]);
  } catch (e) { $('#store-import-status').textContent = t('store_move_err', [(e && e.message) || String(e)]); }
}

applyI18n();
if (!window.showDirectoryPicker) {
  const opt = document.querySelector('#stype option[value="local-folder"]');
  if (opt) opt.remove(); // Firefox: no File System Access, hide the local-folder sink
  const sopt = document.querySelector('#store-backend option[value="folder"]');
  if (sopt) sopt.remove(); // …and the folder store backend
}
$('#stype').onchange = renderFields;
$('#addsink').onclick = addSink;
$('#create').onclick = () => { location.href = 'author.html'; };
$('#browse').onclick = () => { location.href = 'marketplace.html'; };
$('#ds-search').oninput = filterSources;
$('#auto-search').oninput = filterRoutes;
$('#store-backend').onchange = renderStoreFields;
$('#store-move').onclick = moveStore;
$('#store-import').onclick = importFromSink;
$('#store-browse').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/store-browser.html') });
renderStore();
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
// --- "My contributions": the return half of the handoff loop. Poll this contributor's submissions,
// show status + the team's questions, let them reply or re-record. Degrades to empty if the API is down.
function tabBadge(name, n) {
  const btn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
  if (!btn) return;
  btn.querySelector('.tabcount')?.remove();
  if (n > 0) { const s = document.createElement('span'); s.className = 'tabcount pill sent'; s.style.marginLeft = '6px'; s.textContent = String(n); btn.appendChild(s); }
}
async function renderContributions() {
  const wrap = $('#contriblist'); if (!wrap) return;
  const sub = await getSubmitter();
  const list = await getMyHandoffs(sub.id);
  const empty = $('#contribempty'); if (empty) empty.hidden = list.length > 0;
  tabBadge('contributions', unreadCount(list, sub.seen));
  wrap.innerHTML = list.map((h) => {
    const unread = h.lastFrom === 'team' && h.lastAt && (!sub.seen[h.id] || sub.seen[h.id] < h.lastAt);
    const st = t('contrib_status_' + h.status) || esc(h.status);
    return `<div class="card">
      <div class="row"><b style="flex:1">${esc(h.domain)}${unread ? ` <span class="pill sent">● ${t('contrib_new')}</span>` : ''}</b><span class="pill type">${st}</span></div>
      ${h.sourceId ? `<div class="muted">${t('contrib_published_as', [esc(h.sourceId)])}</div>` : ''}
      <div class="muted" style="font-size:12px">${esc(String(h.at || '').slice(0, 10))} · ${h.messages || 0} msg</div>
      <div style="margin-top:6px"><button class="link" data-thread="${esc(h.id)}">${t('contrib_view')}</button>
        <button class="link" data-rerec="${esc(h.domain)}">${t('contrib_rerecord')}</button></div>
      <div id="thr-${esc(h.id)}" hidden style="margin-top:8px;border-top:1px solid #333;padding-top:8px"></div>
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-thread]').forEach((b) => { b.onclick = () => openThread(b.dataset.thread); });
  wrap.querySelectorAll('[data-rerec]').forEach((b) => { b.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/author.html') + '?url=' + encodeURIComponent('https://' + b.dataset.rerec + '/') }); });
}
async function openThread(id) {
  const el = document.getElementById('thr-' + id); if (!el) return;
  if (!el.hidden) { el.hidden = true; return; }
  el.hidden = false; el.textContent = '…';
  const sub = await getSubmitter();
  let data; try { data = await getHandoffThread(id, sub.id); } catch (e) { el.textContent = t('contrib_load_fail'); return; }
  const last = data.messages[data.messages.length - 1];
  if (last) await markSeen(id, last.at);
  el.innerHTML = (data.messages.length ? data.messages : []).map((m) =>
    `<div style="margin:4px 0"><b>${m.from === 'team' ? t('contrib_team') : t('contrib_you')}:</b> ${esc(m.text)} <span class="muted" style="font-size:11px">${esc(String(m.at || '').slice(0, 16))}</span></div>`).join('')
    || `<div class="muted">${t('contrib_no_msgs')}</div>`;
  el.innerHTML += `<div style="margin-top:8px"><textarea id="rep-${esc(id)}" rows="2" style="width:100%;box-sizing:border-box" placeholder="${t('contrib_reply_ph')}"></textarea>
    <button class="primary" data-send="${esc(id)}">${t('contrib_reply')}</button></div>`;
  el.querySelector('[data-send]').onclick = async () => {
    const txt = (document.getElementById('rep-' + id).value || '').trim(); if (!txt) return;
    try { await replyHandoff(id, sub.id, txt); el.hidden = true; await openThread(id); tabBadge('contributions', unreadCount(await getMyHandoffs(sub.id), (await getSubmitter()).seen)); } catch (e) { $('#status') && ($('#status').textContent = t('contrib_reply_fail')); }
  };
  tabBadge('contributions', unreadCount(await getMyHandoffs(sub.id), (await getSubmitter()).seen));
}

(function initTabs() {
  const btns = [...document.querySelectorAll('.tab-btn')];
  const show = (name) => {
    document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.dataset.tab !== name; });
    btns.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    try { localStorage.setItem('habeas-settings-tab', name); } catch (e) {}
    if (name === 'contributions') renderContributions();
  };
  btns.forEach((b) => { b.onclick = () => show(b.dataset.tab); });
  let saved; try { saved = localStorage.getItem('habeas-settings-tab'); } catch (e) {}
  show(btns.some((b) => b.dataset.tab === saved) ? saved : 'sources');
})();

renderFields();
render();
watchThemeIcon();
renderContributions().catch(() => {}); // populate the "My contributions" unread badge on load

// Download planner form: reflect field changes in the live preview; add a schedule.
(function initPlanner() {
  const ids = ['#pl-kind', '#pl-time', '#pl-days', '#pl-ds', '#pl-sink'];
  ids.forEach((s) => { const el = $(s); if (el) el.addEventListener('change', syncPlannerForm); });
  ['#pl-nth', '#pl-weekday'].forEach((s) => { const el = $(s); if (el) el.addEventListener('change', syncPlannerForm); });
  $('#pl-days') && $('#pl-days').addEventListener('input', syncPlannerForm);
  document.addEventListener('change', (e) => { if (e.target && e.target.closest && e.target.closest('#pl-weekdays')) syncPlannerForm(); });
  const add = $('#pl-add');
  if (add) add.onclick = async () => {
    const spec = readSpec(); if (!validateSpec(spec).ok) return;
    const ds = $('#pl-ds').value, sink = $('#pl-sink').value; if (!ds || !sink) return;
    const id = 'sch_' + Math.random().toString(36).slice(2, 9);
    await upsert('schedules', { id, datasource: ds, sink, spec, enabled: true });
    render(); // saveConfig → background re-arms the alarm
  };
})();
