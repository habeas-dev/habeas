import { getConfig } from '../lib/config.js';
import { listInventory, fetchPdf } from '../runtime/inventory.js';
import { writeToSink } from '../sinks/sinks.js';
import CARREFOUR from '../adapters/carrefour-es.js';

const ADAPTERS = { 'carrefour-es': CARREFOUR };
const $ = (s) => document.querySelector(s);
let inventory = [];

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
  const cfg = await getConfig();
  const { adapter } = adapterFor($('#ds').value, cfg);
  if (!adapter) { $('#status').textContent = 'No hay datasource seleccionado.'; return; }
  const auth = await getAuth(adapter);
  if (!auth) { $('#status').textContent = 'Abre carrefour.es → Mis compras para capturar tu sesión, y reintenta.'; return; }
  console.debug('[Habeas] auth headers:', Object.keys(auth).join(', '), '| requestorigin:', auth.requestorigin || '(none)');
  $('#status').textContent = 'Listando…';
  try {
    inventory = await listInventory(adapter, auth);
    render();
    $('#status').textContent = inventory.length + ' documentos';
    $('#sendbar').hidden = inventory.length === 0;
  } catch (e) {
    $('#status').textContent = 'Error: ' + e.message;
  }
}

function render() {
  $('#tbl tbody').innerHTML = inventory.map((d, i) =>
    `<tr>
       <td><input type="checkbox" data-i="${i}" checked></td>
       <td>${(d.date || '').slice(0, 10)}</td>
       <td>${d.type || ''}</td>
       <td>${d.storeName || ''}</td>
       <td class="r">${fmt(d.total)}</td>
     </tr>`).join('');
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

  $('#status').textContent = 'Descargando ' + chosen.length + ' PDFs…';
  const files = new Map();
  for (const d of chosen) {
    try { files.set(d.externalId, await fetchPdf(adapter, auth, d.externalId)); } catch (e) { /* skip */ }
  }
  try {
    const r = await writeToSink(sink, chosen, files, opts);
    $('#status').textContent = 'Enviados ' + (r.written ?? chosen.length) + ' a "' + sink.id + '"';
  } catch (e) {
    $('#status').textContent = 'Sink error: ' + e.message;
  }
}

const fmt = (n) => (typeof n === 'number' ? n.toFixed(2) + ' €' : '');
init();
