import { getConfig } from '../lib/config.js';
import { listInventory, fetchPdf } from '../runtime/inventory.js';
import { writeToSink } from '../sinks/sinks.js';
import { deliveredSet, markDelivered, getLog, appendLog } from '../lib/state.js';
import { badgeWorking, badgeClear } from '../lib/badge.js';
import { watchThemeIcon } from '../lib/theme-icon.js';
import CARREFOUR from '../adapters/carrefour-es.js';

const ADAPTERS = { 'carrefour-es': CARREFOUR };
const $ = (s) => document.querySelector(s);
let inventory = [];
const log = (m) => { const el = $('#log'); if (el) el.textContent += m + '\n'; console.debug('[Habeas]', m); };
const clearLog = () => { const el = $('#log'); if (el) el.textContent = ''; };

async function init() {
  $('#opts').onclick = () => chrome.runtime.openOptionsPage();
  const cfg = await getConfig();
  const enabled = cfg.datasources.filter((d) => d.enabled);
  $('#ds').innerHTML = enabled.map((d) => `<option value="${d.id}">${d.id}</option>`).join('')
    || '<option value="">(sin datasources)</option>';
  $('#sink').innerHTML = cfg.sinks.map((s) => `<option value="${s.id}">${s.id} · ${s.type}</option>`).join('')
    || '<option value="">(sin sinks)</option>';
  if (!enabled.length) $('#status').textContent = 'Activa un datasource en Ajustes.';
  $('#list').onclick = onList;
  $('#send').onclick = onSend;
  $('#sink').onchange = () => render();
  await badgeClear();
  watchThemeIcon();
  await renderActivity();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch['habeas:log']) renderActivity(); });
}

async function renderActivity() {
  const el = $('#activity'); if (!el) return;
  const log = await getLog();
  el.innerHTML = log.slice(0, 25).map((e) => {
    const when = (e.t || '').replace('T', ' ').slice(0, 16);
    const n = e.new ?? e.count;
    const detail = e.status === 'error' ? `⚠️ error: ${e.error}`
      : e.status === 'sin novedades' ? 'sin novedades'
      : e.status === 'sin sesión' ? 'sin sesión'
      : `${n ?? ''} doc(s) → ${e.sink}`;
    return `<div style="border-bottom:1px solid #f0f0f0;padding:3px 0;font:12px system-ui">`
      + `<span style="color:#888">${when}</span> · <b>${e.kind || ''}</b> · ${e.datasource || ''} · ${detail}</div>`;
  }).join('') || '<p class="muted">Sin actividad todavía.</p>';
}

function adapterFor(dsId, cfg) {
  const ds = cfg.datasources.find((d) => d.id === dsId);
  return { ds, adapter: ds && ADAPTERS[ds.adapter] };
}
async function getAuth(adapter) {
  const host = adapter.api.host.replace(/^https?:\/\//, '');
  const o = await chrome.storage.session.get('auth:' + host);
  const store = o['auth:' + host];
  if (!store) return null;
  // Prefer the exact headers the SPA used for the endpoint we are about to call.
  return store.byPath[adapter.api.list.path] || store.merged || null;
}

async function onList() {
  clearLog();
  const cfg = await getConfig();
  const { adapter } = adapterFor($('#ds').value, cfg);
  if (!adapter) { $('#status').textContent = 'No hay datasource seleccionado.'; return; }
  const auth = await getAuth(adapter);
  if (!auth) { $('#status').textContent = 'Abre carrefour.es → Mis compras para capturar tu sesión, y reintenta.'; return; }
  console.debug('[Habeas] auth headers:', Object.keys(auth).join(', '), '| requestorigin:', auth.requestorigin || '(none)');
  $('#status').textContent = 'Listando…';
  try {
    inventory = await listInventory(adapter, auth);
    await render();
    $('#status').textContent = inventory.length + ' documentos';
    log(inventory.length + ' documentos listados');
    $('#sendbar').hidden = inventory.length === 0;
  } catch (e) {
    $('#status').textContent = 'Error: ' + e.message;
  }
}

async function render() {
  const dsId = $('#ds').value, sinkId = $('#sink').value;
  const delivered = sinkId ? await deliveredSet(dsId, sinkId) : {};
  $('#tbl tbody').innerHTML = inventory.map((d, i) => {
    const sent = !!delivered[d.externalId];
    return `<tr>
       <td><input type="checkbox" data-i="${i}" ${sent ? '' : 'checked'}></td>
       <td>${(d.date || '').slice(0, 10)}</td>
       <td>${d.type || ''}</td>
       <td>${d.storeName || ''}</td>
       <td class="r">${fmt(d.total)}</td>
       <td>${sent ? '<span style="color:#888">✓ enviado</span>' : '<b style="color:#0a0">nuevo</b>'}</td>
     </tr>`;
  }).join('');
}

async function onSend() {
  const cfg = await getConfig();
  const sink = cfg.sinks.find((s) => s.id === $('#sink').value);
  if (!sink) { $('#status').textContent = 'Configura un sink en Ajustes.'; return; }
  const { ds, adapter } = adapterFor($('#ds').value, cfg);
  const auth = await getAuth(adapter);
  const chosen = [...document.querySelectorAll('#tbl input:checked')].map((c) => inventory[+c.dataset.i]);
  if (!chosen.length) { $('#status').textContent = 'Nada seleccionado.'; return; }

  const opts = { service: adapter.service || ds.adapter };
  // File System Access needs the picker BEFORE the async downloads (user gesture).
  if (sink.type === 'local-folder') {
    try { opts.dirHandle = await window.showDirectoryPicker(); }
    catch (e) { $('#status').textContent = 'Selección de carpeta cancelada.'; return; }
  }

  $('#status').textContent = 'Obteniendo ' + chosen.length + ' documentos…';
  await badgeWorking();
  const files = new Map();
  const noPdf = [];
  const errors = [];
  for (const d of chosen) {
    try { files.set(d.externalId, await fetchPdf(adapter, auth, d.externalId)); }
    catch (e) {
      if (/\b406\b|sin PDF/.test(e.message)) noPdf.push(d.externalId);
      else errors.push(d.externalId + ' → ' + e.message);
    }
  }
  log(`Con PDF: ${files.size} · sin PDF (Carrefour no los conserva): ${noPdf.length}`
    + (errors.length ? ` · errores: ${errors.length}\n  ${errors.join('\n  ')}` : ''));
  try {
    const r = await writeToSink(sink, chosen, files, opts);
    const m = `Enviado a "${sink.id}": ${r.written} PDF + manifest (${chosen.length} docs, ${noPdf.length} sin PDF)`;
    $('#status').textContent = m; log(m);
    await markDelivered($('#ds').value, sink.id, chosen.map((c) => c.externalId));
    await appendLog({ kind: 'manual', datasource: $('#ds').value, sink: sink.id, status: 'ok', count: chosen.length });
    await render();
    await renderActivity();
  } catch (e) {
    const m = 'Sink error: ' + (e && e.message ? e.message : e);
    $('#status').textContent = m; log(m);
  }
  await badgeClear();
}

const fmt = (n) => (typeof n === 'number' ? n.toFixed(2) + ' €' : '');
init();
