import { chrome } from '../lib/ext.js';
import { getConfig, saveConfig, upsert, remove } from '../lib/config.js';
import { driveSignIn, driveConnected, disconnectDrive, preferDeviceFlow, driveDeviceConnect } from '../sinks/drive.js';
import { dropboxConnect } from '../sinks/dropbox.js';
import { putHandle, getHandle, verifyPermission } from '../lib/fs.js';
import { sinkAcceptsSource } from '../sinks/format.js';
import { renderSinkFields, buildSinkFromForm } from './sinkform.js';
import { watchThemeIcon } from '../lib/theme-icon.js';
import { applyI18n, t } from '../lib/i18n.js';
import { getAdapters, removeSource, isBuiltinSource } from '../adapters/index.js';
import { getStoredSources } from '../adapters/loader.js';
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
import { formatDiag, clearDiag, readReqCtx, clearReqCtx, formatReqCtx } from '../lib/diag.js';
import { validateAdapter } from '../adapters/validate.js';
import { scrubText } from '../lib/redact.js';

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
      const label = g.kind === 'list-sources' ? t('grant_line_listsources', [originHost]) : t('grant_line', [originHost, g.datasourceId]);
      return `<div class="card row"><b style="flex:1">${esc(label)}</b>${used}<button data-revoke="${esc(g.id)}">${t('grant_revoke')}</button></div>`;
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

// The per-type fields now live in the shared sink form (ui/sinkform.js), reused by the first-run assistant.
function renderFields() { $('#sfields').innerHTML = renderSinkFields($('#stype').value); }

async function addSink() {
  const sink = await buildSinkFromForm(document, $('#stype').value); // shared with the first-run assistant
  if (!sink) return;
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
      <div class="row"><b style="flex:1">${esc(h.domain)}${unread ? ` <span class="pill sent">● ${t('contrib_new')}</span>` : ''}${h.hasSource ? ` <span class="pill sent">⬇ ${t('contrib_has_source')}</span>` : ''}</b><span class="pill type">${st}</span></div>
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
// One-click install of the source the team authored from this recording — so the contributor can test it
// without touching any JSON. Saves it, grants consent + capture perms, and enables it as a datasource.
async function installContribSource(adapter) {
  const v = validateAdapter(adapter);
  if (!v.ok) return false;
  await saveSource(adapter);
  if (needsConsent(adapter) && !(await hasConsent(adapter))) { if (!(await confirmConsent(consentDescriptor(adapter)))) return false; await grantConsent(adapter); }
  try { await requestCapturePermissions(adapter); await registerCapture(adapter); } catch (e) {}
  await upsert('datasources', { id: adapter.id, adapter: adapter.id, enabled: true, options: {} });
  return true;
}
// A "Report a problem" message shows the contributor ONLY a plain sentence; the raw technical diagnostic (a
// server error, header names…) rides after this marker — kept for the team (who read the thread raw) and
// hidden from the contributor, who can't act on it and shouldn't be bombarded with it.
const TEAM_DIAG = '\n\n⟦for the Habeas team⟧ ';
const TEAM_DIAG_SPLIT = '⟦for the Habeas team⟧';

async function openThread(id) {
  const el = document.getElementById('thr-' + id); if (!el) return;
  if (!el.hidden) { el.hidden = true; return; }
  el.hidden = false; el.textContent = '…';
  const sub = await getSubmitter();
  let data; try { data = await getHandoffThread(id, sub.id); } catch (e) { el.textContent = t('contrib_load_fail'); return; }
  const last = data.messages[data.messages.length - 1];
  if (last) await markSeen(id, last.at);
  // Latest version + which version is installed here, so the newest build card reads "New version" until it
  // is installed. A version send is just a team message that carries a source, so it rides the timeline.
  const latestVer = data.source ? String(data.source.version || '') : '';
  let installedVer = '';
  try { const o = await chrome.storage.local.get('habeas:contribVer:' + id); installedVer = o['habeas:contribVer:' + id] || ''; } catch (e) {}
  let lastVerIdx = -1; data.messages.forEach((m, i) => { if (m.source && m.source.id) lastVerIdx = i; });
  // A build the team sent, shown inline in the conversation: service name + version + install/reinstall, with a
  // plain state pill (no technical "what changed" — the contributor can't act on it). The NEWEST build is
  // highlighted "New version" until this exact version is installed here; earlier ones are "Previous version"
  // and stay reinstallable, so current AND previous builds are visible and re-testable.
  const versionCard = (src, mi, isLatest) => {
    const ver = String(src.version || '');
    const isNew = isLatest && ver !== installedVer;
    const pill = isLatest
      ? (isNew ? `<span class="pill new">${t('contrib_new_version')}</span>` : `<span class="pill sent">✓ ${t('contrib_installed_ver')}</span>`)
      : `<span class="pill type">${t('contrib_prev_version')}</span>`;
    return `<div class="srcbox${isNew ? ' newver' : ''}" data-vcard="${esc(String(mi))}">
      <div><b>${esc(src.name || src.id)}</b> ${ver ? `<span class="ver">v${esc(ver)}</span>` : ''} ${pill}</div>
      <button class="${isLatest ? 'accent' : ''}" data-vinst="${esc(String(mi))}" style="margin-top:8px">${isNew ? t('contrib_install') : t('contrib_reinstall')}</button>
      <span class="muted" data-vstat="${esc(String(mi))}" style="font-size:12px"></span></div>`;
  };
  // Messages as clearly-separated bubbles, sided by sender (team left, you right); a version send renders as a
  // team bubble with its build card inline.
  el.innerHTML = data.messages.length
    ? `<div class="thread">${data.messages.map((m, mi) => {
      if (m.source && m.source.id) {                          // a version the team sent → a build card in the timeline
        const note = String(m.text || '').trim();
        return `<div class="msg team"><div><span class="who">${t('contrib_team')}</span><span class="when">${esc(String(m.at || '').slice(0, 16))}</span></div>`
          + (note ? `<div class="body">${esc(note)}</div>` : '')
          + versionCard(m.source, mi, mi === lastVerIdx)
          + `</div>`;
      }
      if (m.captureRequest && m.captureRequest.instruction) {  // the team asked for a specific, guided capture
        return `<div class="msg team"><div><span class="who">${t('contrib_team')}</span><span class="when">${esc(String(m.at || '').slice(0, 16))}</span></div>`
          + `<div class="srcbox newver"><div><b>🎯 ${t('contrib_capreq_title')}</b></div>`
          + `<div class="body" style="margin-top:4px">${esc(m.captureRequest.instruction)}</div>`
          + `<button class="accent" data-capreq="${mi}" style="margin-top:8px">${t('contrib_capreq_start')}</button></div></div>`;
      }
      const mine = m.from !== 'team';
      const parts = String(m.text || '').split(TEAM_DIAG_SPLIT);
      const shown = parts[0].trim();                          // the plain message the contributor reads
      const detail = parts.length > 1 ? parts.slice(1).join(TEAM_DIAG_SPLIT).trim() : ''; // the technical trace, if any
      return `<div class="msg ${mine ? 'you' : 'team'}"><div><span class="who">${mine ? t('contrib_you') : t('contrib_team')}</span><span class="when">${esc(String(m.at || '').slice(0, 16))}</span></div>`
        + `<div class="body">${esc(shown)}</div>`
        + (detail ? `<button class="link" data-peek="${mi}">${t('contrib_show_detail')}</button><pre class="diagbox" hidden data-detail="${mi}">${esc(detail)}</pre>` : '')
        + `</div>`;
    }).join('')}</div>`
    : `<div class="muted">${t('contrib_no_msgs')}</div>`;
  // Delegate on `el` (single handler, survives the later el.innerHTML += rebuilds and doesn't stack on
  // re-render): "See technical detail" toggles + a targeted capture request opens the guided recorder
  // (the author page) prefilled with the source site, the plain instruction, and the endpoint hint so it
  // confirms when the contributor captured what's needed.
  el.onclick = (ev) => {
    const pk = ev.target.closest && ev.target.closest('[data-peek]');
    if (pk) { const d = el.querySelector(`[data-detail="${pk.dataset.peek}"]`); if (d) d.hidden = !d.hidden; return; }
    const cq = ev.target.closest && ev.target.closest('[data-capreq]');
    if (cq) {
      const cr = data.messages[cq.dataset.capreq] && data.messages[cq.dataset.capreq].captureRequest;
      if (!cr) return;
      const site = 'https://www.' + (data.domain || '') + '/';
      const url = chrome.runtime.getURL('src/ui/author.html') + '?url=' + encodeURIComponent(site)
        + '&guide=' + encodeURIComponent(cr.instruction) + (cr.endpoint ? '&endpoint=' + encodeURIComponent(cr.endpoint) : '')
        + '&handoff=' + encodeURIComponent(id); // attach the recording back to THIS handoff (same thread)
      try { chrome.tabs.create({ url }); } catch (e) { location.href = url; }
    }
  };
  // Backward compatibility: a source attached BEFORE version messages existed has no timeline card — show the
  // latest as a single build card so it can still be installed (no history existed for it either way).
  if (data.source && data.source.id && lastVerIdx === -1) {
    el.innerHTML += `<div class="thread"><div class="msg team">${versionCard(data.source, 'latest', true)}</div></div>`;
  }
  // Report a problem — ALWAYS available while a source is installed to test, so it never vanishes after one
  // report and the contributor can flag EACH new failure. The plain "it didn't work" goes to the thread; the
  // latest technical trace (read at click time, so it's the newest) rides hidden for the team.
  if (data.source && data.source.id) {
    el.innerHTML += `<div style="margin-top:8px"><button id="rep-diag-${esc(id)}">${t('contrib_report')}</button>
      <button class="link" id="rep-peek-${esc(id)}">${t('contrib_report_peek')}</button>
      <span id="repstat-${esc(id)}" class="muted" style="font-size:12px"></span>
      <pre id="rep-detail-${esc(id)}" class="diagbox" hidden></pre></div>`;
  }
  el.innerHTML += `<div style="margin-top:8px"><textarea id="rep-${esc(id)}" rows="2" style="width:100%;box-sizing:border-box" placeholder="${t('contrib_reply_ph')}"></textarea>
    <button class="primary" data-send="${esc(id)}">${t('contrib_reply')}</button></div>`;
  if (data.source && data.source.id) {
    // Read the CURRENT technical trace (freshest failure) — used both to preview and to send.
    const readDiag = async () => { if (!data.sourceId) return null; try { const o = await chrome.storage.local.get('habeas:diag:' + data.sourceId); return o['habeas:diag:' + data.sourceId] || null; } catch (e) { return null; } };
    // Stamp every report with the Habeas build + the installed source version, so the team never has to guess
    // WHICH extension/source produced a result (we've shuffled both a lot mid-debug). Always sent, even with no
    // failure trace. Installed source version = what's actually installed here (habeas:contribVer), not the
    // latest offered in the thread.
    const reportMeta = async () => {
      let ext = ''; try { ext = chrome.runtime.getManifest().version; } catch (e) {}
      const sid = data.sourceId || (data.source && data.source.id) || '';
      // Report the version ACTUALLY installed (from the stored adapter) — not the latest OFFERED in the thread.
      // The earlier fallback to data.source.version masked "you're testing an old build of the source": it read
      // v0.8 while the running adapter was v0.7. Marks whether the source is even installed.
      let sv = '', installed = false;
      try { const stored = (await getStoredSources()).find((a) => a.id === sid); if (stored) { sv = String(stored.version || ''); installed = true; } } catch (e) {}
      if (!installed) { try { const o = await chrome.storage.local.get('habeas:contribVer:' + id); if (o['habeas:contribVer:' + id]) sv = o['habeas:contribVer:' + id]; } catch (e) {} }
      return 'Habeas ' + (ext || '?') + (sid ? ' · source ' + sid + (sv ? ' v' + sv : '') + (installed ? ' (installed)' : ' (NOT installed)') : '');
    };
    // "See what's sent": full transparency, behind a button — the exact message (plain line + the technical
    // trace) that would go to the team, so the contributor is never suspicious about what leaves their machine.
    const pk = document.getElementById('rep-peek-' + id);
    if (pk) pk.onclick = async () => {
      const box = document.getElementById('rep-detail-' + id); if (!box) return;
      if (!box.hidden) { box.hidden = true; return; }
      const d = await readDiag();
      const meta = await reportMeta();
      const trace = formatDiag(d) + formatReqCtx(data.sourceId ? await readReqCtx(data.sourceId) : []);
      box.textContent = t('contrib_report_prefix') + '\n\n' + meta + (trace ? '\n' + scrubText(trace).slice(0, 1800) : '\n(' + t('contrib_report_none') + ')');
      box.hidden = false;
    };
    const rb = document.getElementById('rep-diag-' + id);
    if (rb) rb.onclick = async () => {
      rb.disabled = true;
      const d = await readDiag();
      const meta = await reportMeta();
      const trace = formatDiag(d) + formatReqCtx(data.sourceId ? await readReqCtx(data.sourceId) : []);
      const tail = TEAM_DIAG + meta + (trace ? '\n' + scrubText(trace).slice(0, 10000) : ''); // version always rides; fits the server's handoff-message limit
      try {
        await replyHandoff(id, sub.id, t('contrib_report_prefix') + tail);
        if (trace && data.sourceId) { await clearDiag(data.sourceId); await clearReqCtx(data.sourceId); }
        el.hidden = true; await openThread(id); // re-render: the report appears + the button stays for the next one
      } catch (e) {
        rb.disabled = false; // let the contributor retry, and SAY it failed instead of doing nothing
        const st = document.getElementById('repstat-' + id); if (st) st.textContent = t('contrib_report_fail');
      }
    };
  }
  // Install any build in the timeline (the latest OR a previous one). Tracks the installed version so the
  // newest card flips from "New version" to "installed", and older cards stay reinstallable.
  el.querySelectorAll('[data-vinst]').forEach((b) => {
    b.onclick = async () => {
      const mi = b.dataset.vinst;
      const src = mi === 'latest' ? data.source : (data.messages[mi] && data.messages[mi].source);
      if (!src) return;
      b.disabled = true;
      const ok = await installContribSource(src);
      const st = el.querySelector(`[data-vstat="${mi}"]`);
      if (st) st.textContent = ok ? t('contrib_installed') : t('contrib_install_fail');
      if (ok) {
        try { await chrome.storage.local.set({ ['habeas:contribVer:' + id]: String(src.version || '') }); } catch (e) {}
        const card = el.querySelector(`[data-vcard="${mi}"]`); if (card) card.classList.remove('newver');
      }
      b.disabled = false;
    };
  });
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
