import { chrome } from '../lib/ext.js';
import { getConfig } from '../lib/config.js';
import { listInventory, fetchDocument, documentExt } from '../runtime/inventory.js';
import { resolveSiteFetch } from '../lib/pagefetch.js';
import { writeToSink } from '../sinks/sinks.js';
import { sinkAcceptsSource, acceptsDoc } from '../sinks/format.js';
import { deliveredSet, markDelivered, getLog, appendLog } from '../lib/state.js';
import { badgeWorking, badgeClear } from '../lib/badge.js';
import { getHandle, verifyPermission } from '../lib/fs.js';
import { watchThemeIcon } from '../lib/theme-icon.js';
import { applyI18n, t } from '../lib/i18n.js';
import { getAdapters } from '../adapters/index.js';
import { hasConsent } from '../lib/consent.js';

let ADAPTERS = {};
const $ = (s) => document.querySelector(s);
let inventory = [];
const log = (m) => { const el = $('#log'); if (el) el.textContent += m + '\n'; console.debug('[Habeas]', m); };
const clearLog = () => { const el = $('#log'); if (el) el.textContent = ''; };
const fmt = (n) => (typeof n === 'number' ? n.toFixed(2) + ' €' : '');
const localWhen = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso || '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function init() {
  applyI18n();
  $('#opts').onclick = () => chrome.runtime.openOptionsPage();
  ADAPTERS = await getAdapters();
  const cfg = await getConfig();
  const enabled = cfg.datasources.filter((d) => d.enabled);
  $('#ds').innerHTML = enabled.map((d) => `<option value="${d.id}">${d.id}</option>`).join('') || '<option value="">—</option>';
  populateSinks(cfg);
  if (!enabled.length) $('#status').textContent = t('no_datasources');
  $('#list').onclick = onList;
  $('#send').onclick = onSend;
  $('#sink').onchange = () => render();
  $('#ds').onchange = async () => { populateSinks(await getConfig()); render(); };
  $('#sel-new').onclick = () => setSelection('new');
  $('#sel-all').onclick = () => setSelection('all');
  $('#sel-none').onclick = () => setSelection('none');
  await badgeClear();
  watchThemeIcon();
  await renderActivity();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch['habeas:log']) renderActivity(); });
}

function adapterFor(dsId, cfg) {
  const ds = cfg.datasources.find((d) => d.id === dsId);
  return { ds, adapter: ds && ADAPTERS[ds.adapter] };
}
// Only offer sinks that accept this data source (by category / source allowlist).
function populateSinks(cfg) {
  const { adapter } = adapterFor($('#ds').value, cfg);
  const list = cfg.sinks.filter((s) => !adapter || sinkAcceptsSource(s, adapter));
  $('#sink').innerHTML = list.map((s) => `<option value="${s.id}">${s.id} · ${s.type}</option>`).join('') || '<option value="">—</option>';
}
async function getAuth(adapter) {
  const cookie = adapter.auth && adapter.auth.mode === 'cookie';
  const host = adapter.api.host.replace(/^https?:\/\//, '');
  const o = await chrome.storage.session.get('auth:' + host);
  const store = o['auth:' + host];
  // Return the whole store so each endpoint (list / detail / PDF) resolves its own auth (mixed
  // cookie+bearer is supported). Cookie sources proceed with an empty store (cookies carry it).
  if (!store) return cookie ? { byPath: {}, merged: {} } : null;
  return { byPath: store.byPath || {}, merged: store.merged || {} };
}

async function onList() {
  clearLog();
  const cfg = await getConfig();
  const { adapter } = adapterFor($('#ds').value, cfg);
  if (!adapter) { $('#status').textContent = t('no_datasources'); return; }
  if (!(await hasConsent(adapter))) { $('#status').textContent = t('needs_consent'); return; }
  const auth = await getAuth(adapter);
  if (!auth) { $('#status').textContent = t('capture_hint'); return; }
  $('#status').textContent = t('listing');
  try {
    const net = await resolveSiteFetch(adapter);
    inventory = await listInventory(adapter, auth, net);
    await render();
    $('#status').textContent = t('n_documents', [String(inventory.length)]);
    log(t('n_documents', [String(inventory.length)]));
    $('#sendbar').hidden = inventory.length === 0;
    $('#selbar').hidden = inventory.length === 0;
  } catch (e) {
    $('#status').textContent = t('generic_error', [e.message]);
  }
}

async function render() {
  const dsId = $('#ds').value, sinkId = $('#sink').value;
  const delivered = sinkId ? await deliveredSet(dsId, sinkId) : {};
  $('#tbl tbody').innerHTML = inventory.map((d, i) => {
    const sent = !!delivered[d.internalId];
    return `<tr data-sent="${sent ? '1' : ''}">
       <td><input type="checkbox" data-i="${i}" ${sent ? '' : 'checked'}></td>
       <td>${(d.date || '').slice(0, 10)}</td>
       <td><span class="pill type">${d.type || ''}</span></td>
       <td>${d.storeName || d.label || ''}</td>
       <td class="r">${fmt(d.total ?? d.amount)}</td>
       <td>${sent ? `<span class="pill sent">${t('pill_sent')}</span>` : `<span class="pill new">${t('pill_new')}</span>`}</td>
     </tr>`;
  }).join('');
}

function setSelection(mode) {
  document.querySelectorAll('#tbl tbody tr').forEach((tr) => {
    const cb = tr.querySelector('input[type=checkbox]');
    if (cb) cb.checked = mode === 'all' ? true : mode === 'none' ? false : !tr.dataset.sent;
  });
}

async function onSend() {
  const cfg = await getConfig();
  const sink = cfg.sinks.find((s) => s.id === $('#sink').value);
  if (!sink) { $('#status').textContent = t('pick_sink'); return; }
  const { ds, adapter } = adapterFor($('#ds').value, cfg);
  if (!(await hasConsent(adapter))) { $('#status').textContent = t('needs_consent'); return; }
  const auth = await getAuth(adapter);
  const chosen = [...document.querySelectorAll('#tbl input:checked')].map((c) => inventory[+c.dataset.i]);
  if (!chosen.length) { $('#status').textContent = t('nothing_selected'); return; }
  const eligible = chosen.filter((d) => acceptsDoc(sink, d));
  const skipped = chosen.length - eligible.length;
  if (!eligible.length) { $('#status').textContent = t('none_compatible'); return; }

  const opts = { service: adapter.service || ds.adapter, ext: documentExt(adapter) || 'pdf' };
  if (sink.type === 'local-folder') {
    const handle = await getHandle('dir:' + sink.id);
    if (!handle) { $('#status').textContent = t('configure_folder'); return; }
    if (!(await verifyPermission(handle))) { $('#status').textContent = t('folder_denied'); return; }
    opts.dirHandle = handle;
  }

  $('#status').textContent = t('fetching', [String(eligible.length)]);
  await badgeWorking();
  const net = await resolveSiteFetch(adapter);
  const files = new Map();
  const noPdf = [];
  for (const d of eligible) {
    try { files.set(d.internalId, (await fetchDocument(adapter, auth, d.internalId, net)).blob); }
    catch (e) { if (/\b406\b|sin PDF|no PDF|no document/i.test(e.message)) noPdf.push(d.internalId); }
  }
  log(t('with_without_pdf', [String(files.size), String(noPdf.length)]) + (skipped ? ' · ' + t('skipped_incompat', [String(skipped)]) : ''));
  try {
    const r = await writeToSink(sink, eligible, files, opts);
    const m = t('sent_result', [sink.id, String(r.written), String(eligible.length), String(noPdf.length)]);
    $('#status').textContent = m; log(m);
    await markDelivered($('#ds').value, sink.id, eligible.map((c) => c.internalId));
    await appendLog({ kind: 'manual', datasource: $('#ds').value, sink: sink.id, status: 'ok', count: eligible.length });
    await render();
    await renderActivity();
  } catch (e) {
    const m = t('sink_error', [(e && e.message) || String(e)]);
    $('#status').textContent = m; log(m);
  }
  await badgeClear();
}

async function renderActivity() {
  const el = $('#activity'); if (!el) return;
  const entries = await getLog();
  el.innerHTML = entries.slice(0, 25).map((e) => {
    const when = localWhen(e.t);
    const n = e.new ?? e.count;
    const detail = e.status === 'error' ? t('st_error', [e.error || ''])
      : e.status === 'none' ? t('st_none')
      : e.status === 'nosession' ? t('st_nosession')
      : t('st_ok', [String(n ?? ''), e.sink || '']);
    return `<div class="activity-item"><span class="when">${when}</span><span class="kind">${e.kind || ''}</span><span>${e.datasource || ''} · ${detail}</span></div>`;
  }).join('') || `<p class="muted">${t('no_activity')}</p>`;
}

init();
