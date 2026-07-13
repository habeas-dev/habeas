// Debug browser for the canonical store: what's saved per source (records + doc availability + when
// recorded + tombstones) and, overlaid against a sink's delivery ledger, what's delivered vs pending.
// IMPORTANT distinction (a frequent confusion): the canonical STORE and a delivery SINK are separate.
// Downloading to a Dropbox *sink* does NOT move the store to Dropbox — the store stays on its configured
// backend (local by default). So this page lets you pick WHICH backend to inspect: the configured store,
// plain local, or a specific cloud sink's store. Can also DELETE store data and reset a sink's ledger.
import { getStoreConfig, openBackend } from '../lib/store.js';
import { emptySource } from '../lib/store/format.js';
import { deliveredSet, forgetDeliveredItems } from '../lib/state.js';
import { getConfig } from '../lib/config.js';
import { esc } from '../lib/esc.js';

const $ = (s) => document.querySelector(s);
const money = (v, c) => (v == null || v === '' ? '' : `${v} ${c || ''}`.trim());
const storeName = (r) => (r.store && r.store.name) || (r.issuer && r.issuer.name) || r.storeName || '';
const selectedIds = () => [...document.querySelectorAll('.sel:checked')].map((c) => c.dataset.id);

const SINK_STORE_TYPES = new Set(['dropbox', 'webdav', 's3', 'drive', 'folder', 'http']);
let backends = [];       // [{ label, cfg }]
let backend = null;      // the resolved backend object currently inspected

async function init() {
  const storeCfg = await getStoreConfig();
  const conf = await getConfig();
  // Backend choices: the configured store, plain local, and every sink that can host a store.
  backends = [
    { label: `configurado (${storeCfg.backend}${storeCfg.sinkId ? ' · ' + storeCfg.sinkId : ''})`, cfg: storeCfg },
    { label: 'local (IndexedDB)', cfg: { backend: 'local' } },
    ...(conf.sinks || []).filter((s) => SINK_STORE_TYPES.has(s.type))
      .map((s) => ({ label: `sink ${s.id} (${s.type})`, cfg: { backend: s.type, sinkId: s.id } })),
  ];
  $('#backend').innerHTML = backends.map((b, i) => `<option value="${i}">${esc(b.label)}</option>`).join('');
  $('#sink').innerHTML = '<option value="">— sin overlay de entrega —</option>' + (conf.sinks || []).map((s) => `<option value="${esc(s.id)}">${esc(s.id)}</option>`).join('');
  $('#backend').onchange = loadBackend;
  $('#source').onchange = render;
  $('#sink').onchange = render;
  $('#refresh').onclick = loadBackend;
  $('#sel-all').onchange = (e) => { document.querySelectorAll('.sel').forEach((c) => { c.checked = e.target.checked; }); updateCounts(); };
  $('#del-items').onclick = onDeleteItems;
  $('#reset-ledger').onclick = onResetLedger;
  $('#clear-source').onclick = onClearSource;
  await loadBackend();
}

// (Re)open the chosen backend and list its sources. Any backend error (cloud not connected, no token in this
// tab) is surfaced verbatim instead of silently looking empty.
async function loadBackend() {
  const cfg = backends[+$('#backend').value].cfg;
  $('#source').innerHTML = '<option value="">…</option>';
  $('#summary').textContent = 'abriendo backend…';
  $('#actions').hidden = true;
  try {
    backend = await openBackend(cfg);
    const sources = (await backend.listSources()).slice().sort();
    $('#source').innerHTML = sources.length
      ? sources.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')
      : '<option value="">(este backend no tiene ninguna fuente)</option>';
    $('#summary').textContent = sources.length ? `${sources.length} fuente(s) en este backend` : 'backend accesible pero vacío — ¿estás mirando el backend correcto? El store es independiente del sink de entrega.';
    if (sources.length) await render();
  } catch (e) {
    backend = null;
    $('#source').innerHTML = '<option value="">(backend no accesible)</option>';
    $('#summary').innerHTML = `<span class="err">No se pudo abrir el backend: ${esc((e && e.message) || String(e))}</span>`;
  }
}

function updateCounts() {
  const n = selectedIds().length;
  $('#del-items').textContent = `Borrar del almacén (${n})`;
  $('#reset-ledger').textContent = `Marcar no entregados (${n})`;
}

async function render() {
  const sourceId = $('#source').value;
  $('#actions').hidden = !sourceId || !backend;
  if (!sourceId || !backend) { $('#tbody').innerHTML = ''; return; }
  $('#summary').textContent = 'cargando fuente…';
  let src;
  try { src = await backend.loadSource(sourceId); }
  catch (e) { $('#tbody').innerHTML = ''; $('#summary').innerHTML = `<span class="err">Error cargando «${esc(sourceId)}»: ${esc((e && e.message) || String(e))}</span>`; return; }
  if (!src || !src.items || !Object.keys(src.items).length) {
    $('#tbody').innerHTML = '';
    $('#summary').textContent = src ? `«${sourceId}» existe en el store pero está vacío (0 items).` : `«${sourceId}» aparece en el listado pero el backend responde "no existe" al cargarlo (fichero renombrado/movido o borrado a medias).`;
    return;
  }
  const sinkId = $('#sink').value;
  $('#reset-ledger').hidden = !sinkId;
  // The store key is "<sourceId>:<stream>"; the delivery ledger is keyed by the DATASOURCE id (before ":").
  const delivered = sinkId ? await deliveredSet(sourceId.split(':')[0], sinkId) : null;

  // The canonical store keys items by internalId — the id lives ONLY as the map KEY (cleanEntry drops it
  // from the value), so read it from the key, not e.internalId.
  const items = Object.entries(src.items);
  let live = 0, gone = 0, withDoc = 0, deliveredN = 0, pending = 0;
  const rows = items.map(([id, e]) => {
    const r = e.record || {};
    const isGone = !!e.gone;
    const isDelivered = delivered ? !!delivered[id] : null;
    if (isGone) gone++; else live++;
    if (e.docAvailable) withDoc++;
    if (delivered && !isGone) (isDelivered ? deliveredN++ : pending++);
    return { id, e, r, isGone, isDelivered };
  }).sort((a, b) => ((a.r.date || '') < (b.r.date || '') ? 1 : -1)); // newest first for display

  $('#summary').textContent = `${items.length} items · ${live} vivos · ${gone} tombstones · ${withDoc} con documento`
    + (delivered ? ` · ${deliveredN} entregados · ${pending} pendientes → ${sinkId}` : '');

  $('#tbody').innerHTML = rows.map(({ id, e, r, isGone, isDelivered }) => {
    const status = isGone ? `<span class="pill gone">gone${e.goneReason ? ' · ' + esc(e.goneReason) : ''}</span>`
      : delivered ? (isDelivered ? '<span class="pill ok">entregado</span>' : '<span class="pill pend">pendiente</span>')
      : '<span class="pill">—</span>';
    return `<tr>
      <td><input type="checkbox" class="sel" data-id="${esc(id)}"></td>
      <td class="idcell">${esc(id)}</td>
      <td>${esc((r.date || '').slice(0, 10))}</td>
      <td>${esc(storeName(r))}${r.group ? ' <span class="muted">· ' + esc(r.group) + '</span>' : ''}</td>
      <td class="r">${esc(money(r.total ?? r.amount, r.currency))}</td>
      <td>${esc(r.type || '')}</td>
      <td>${e.docAvailable ? '📄' : ''}</td>
      <td class="muted">${esc((e.at || '').slice(0, 19).replace('T', ' '))}</td>
      <td>${status}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="muted">sin items</td></tr>';
  document.querySelectorAll('.sel').forEach((c) => { c.onchange = updateCounts; });
  $('#sel-all').checked = false;
  updateCounts();
}

async function onDeleteItems() {
  const sourceId = $('#source').value; const ids = selectedIds();
  if (!backend || !sourceId || !ids.length) return;
  if (!confirm(`Borrar ${ids.length} item(s) del almacén de «${sourceId}»? No se puede deshacer.`)) return;
  const src = await backend.loadSource(sourceId);
  if (src && src.items) { for (const id of ids) delete src.items[String(id)]; await backend.saveSource(sourceId, src); }
  await render();
}

async function onClearSource() {
  const sourceId = $('#source').value;
  if (!backend || !sourceId) return;
  if (!confirm(`Vaciar TODO el almacén de «${sourceId}»? Se borran todos sus registros. No se puede deshacer.`)) return;
  const src = await backend.loadSource(sourceId);
  await backend.saveSource(sourceId, { ...emptySource((src && src.meta) || {}), items: {} });
  await render();
}

async function onResetLedger() {
  const sinkId = $('#sink').value; const ids = selectedIds();
  if (!sinkId || !ids.length) return;
  if (!confirm(`Marcar ${ids.length} item(s) como NO entregados a «${sinkId}»? Se volverán a enviar en el próximo envío.`)) return;
  await forgetDeliveredItems($('#source').value.split(':')[0], sinkId, ids);
  await render();
}

init();
