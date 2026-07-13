// Debug browser for the canonical store: what's saved per source (records + doc availability + when
// recorded + tombstones) and, overlaid against a sink's delivery ledger, what's delivered vs pending.
// Reads the CURRENTLY-configured store backend (local / folder / Drive / Dropbox / WebDAV / S3 / HTTP).
// Can DELETE store data (selected items or the whole source) and reset a sink's "delivered" ledger.
import { getStoreConfig, listSources, getSource, deleteStoreItems, clearStoreSource } from '../lib/store.js';
import { deliveredSet, forgetDeliveredItems } from '../lib/state.js';
import { getConfig } from '../lib/config.js';
import { esc } from '../lib/esc.js';

const $ = (s) => document.querySelector(s);
const money = (v, c) => (v == null || v === '' ? '' : `${v} ${c || ''}`.trim());
const storeName = (r) => (r.store && r.store.name) || (r.issuer && r.issuer.name) || r.storeName || '';
const selectedIds = () => [...document.querySelectorAll('.sel:checked')].map((c) => c.dataset.id);

async function init() {
  const cfg = await getStoreConfig();
  $('#backend').textContent = cfg.backend + (cfg.sinkId ? ' · sink ' + cfg.sinkId : '') + (cfg.url ? ' · ' + cfg.url : '');
  const sources = (await listSources()).slice().sort();
  $('#source').innerHTML = sources.length ? sources.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('') : '<option value="">(almacén vacío)</option>';
  const conf = await getConfig();
  $('#sink').innerHTML = '<option value="">— sin overlay de entrega —</option>' + (conf.sinks || []).map((s) => `<option value="${esc(s.id)}">${esc(s.id)}</option>`).join('');
  $('#source').onchange = render;
  $('#sink').onchange = render;
  $('#refresh').onclick = render;
  $('#sel-all').onchange = (e) => { document.querySelectorAll('.sel').forEach((c) => { c.checked = e.target.checked; }); updateCounts(); };
  $('#del-items').onclick = onDeleteItems;
  $('#reset-ledger').onclick = onResetLedger;
  $('#clear-source').onclick = onClearSource;
  if (sources.length) render();
}

function updateCounts() {
  const n = selectedIds().length;
  $('#del-items').textContent = `Borrar del almacén (${n})`;
  $('#reset-ledger').textContent = `Marcar no entregados (${n})`;
}

async function render() {
  const sourceId = $('#source').value;
  $('#actions').hidden = !sourceId;
  if (!sourceId) { $('#tbody').innerHTML = ''; $('#summary').textContent = ''; return; }
  $('#summary').textContent = 'cargando…';
  const src = await getSource(sourceId);
  if (!src || !src.items) { $('#tbody').innerHTML = ''; $('#summary').textContent = 'sin datos para esta fuente (¿backend no accesible / no conectado?)'; return; }
  const sinkId = $('#sink').value;
  $('#reset-ledger').hidden = !sinkId;
  // The store key is "<sourceId>:<stream>"; the delivery ledger is keyed by the DATASOURCE id (before ":").
  const delivered = sinkId ? await deliveredSet(sourceId.split(':')[0], sinkId) : null;

  const items = Object.values(src.items);
  let live = 0, gone = 0, withDoc = 0, deliveredN = 0, pending = 0;
  const rows = items.map((e) => {
    const r = e.record || {};
    const isGone = !!e.gone;
    const isDelivered = delivered ? !!delivered[String(e.internalId)] : null;
    if (isGone) gone++; else live++;
    if (e.docAvailable) withDoc++;
    if (delivered && !isGone) (isDelivered ? deliveredN++ : pending++);
    return { e, r, isGone, isDelivered };
  }).sort((a, b) => ((a.r.date || '') < (b.r.date || '') ? 1 : -1)); // newest first for display

  $('#summary').textContent = `${items.length} items · ${live} vivos · ${gone} tombstones · ${withDoc} con documento`
    + (delivered ? ` · ${deliveredN} entregados · ${pending} pendientes → ${sinkId}` : '');

  $('#tbody').innerHTML = rows.map(({ e, r, isGone, isDelivered }) => {
    const status = isGone ? `<span class="pill gone">gone${e.goneReason ? ' · ' + esc(e.goneReason) : ''}</span>`
      : delivered ? (isDelivered ? '<span class="pill ok">entregado</span>' : '<span class="pill pend">pendiente</span>')
      : '<span class="pill">—</span>';
    return `<tr>
      <td><input type="checkbox" class="sel" data-id="${esc(String(e.internalId))}"></td>
      <td class="idcell">${esc(String(e.internalId))}</td>
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
  const ids = selectedIds();
  if (!ids.length) return;
  if (!confirm(`Borrar ${ids.length} item(s) del almacén de «${$('#source').value}»? No se puede deshacer.`)) return;
  await deleteStoreItems($('#source').value, ids);
  await render();
}

async function onClearSource() {
  const sourceId = $('#source').value;
  if (!sourceId) return;
  if (!confirm(`Vaciar TODO el almacén de «${sourceId}»? Se borran todos sus registros. No se puede deshacer.`)) return;
  await clearStoreSource(sourceId);
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
