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
import { recordsToCsv, storeSourceRecords, csvFileName } from '../lib/csv.js';
import { recordsToQif, qifFileName } from '../lib/qif.js';
import { t, applyI18n } from '../lib/i18n.js';

const $ = (s) => document.querySelector(s);
const DECIMAL_KEY = 'habeas-csv-decimal';
const FORMAT_KEY = 'habeas-export-format';
const QIF_DATE_KEY = 'habeas-qif-date';
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
  $('#export-run').onclick = () => exportStore(false);
  $('#export-run-all').onclick = () => exportStore(true);
  // Remember the export choices: whoever needs the comma (opens the file in a spreadsheet) or QIF (feeds a
  // desktop finance app) needs it EVERY time, and re-picking it on each export is the kind of friction that
  // ends in a wrong file.
  restoreChoice(FORMAT_KEY, '#export-format', ['csv', 'qif']);
  restoreChoice(DECIMAL_KEY, '#csv-decimal', ['.', ',']);
  restoreChoice(QIF_DATE_KEY, '#qif-date', ['DMY', 'MDY']);
  $('#export-format').onchange = (e) => { remember(FORMAT_KEY, e.target.value); showFormatOptions(); };
  $('#csv-decimal').onchange = (e) => remember(DECIMAL_KEY, e.target.value);
  $('#qif-date').onchange = (e) => remember(QIF_DATE_KEY, e.target.value);
  showFormatOptions();
  applyI18n(document);
  await loadBackend();
}

// A remembered <select> choice (best-effort: private mode has no localStorage, and a missing choice is not
// worth an error — the default is always a sane one).
function remember(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* ignore */ } }
function restoreChoice(key, selector, allowed) {
  try {
    const saved = localStorage.getItem(key);
    if (allowed.includes(saved)) $(selector).value = saved;
  } catch (e) { /* private mode: just use the default */ }
}

// The decimal mark is a CSV-only decision (a QIF always uses a dot — see lib/qif.js) and the date order is a
// QIF-only one (a CSV keeps the store's ISO dates), so only the relevant one is shown.
function showFormatOptions() {
  const qif = $('#export-format').value === 'qif';
  $('#csv-decimal-label').hidden = qif;
  $('#qif-date-label').hidden = !qif;
}

// Export the store — another PROJECTION of the canonical store (docs/canonical-store.md), not a new copy of
// the data: the records are the ones already held, laid out as a spreadsheet (CSV) or as the file format
// desktop finance apps import (QIF). Tombstoned items are left out (they no longer exist at the source).
// The generation is pure (lib/csv.js, lib/qif.js); this only downloads it.
async function exportStore(all) {
  if (!backend) return;
  const sources = all ? (await backend.listSources()).slice().sort() : [$('#source').value].filter(Boolean);
  if (!sources.length) return;
  const records = [];
  for (const sourceId of sources) {
    let src;
    try { src = await backend.loadSource(sourceId); } catch (e) { continue; } // a broken source must not lose the rest
    // Stamp the store key on records that carry no `source` of their own, so an all-sources export stays attributable.
    for (const r of storeSourceRecords(src)) records.push(r.source ? r : { ...r, source: sourceId });
  }
  if (!records.length) { alert(t('store_export_empty')); return; }
  const sourceId = all ? 'all' : sources[0];
  if ($('#export-format').value === 'qif') return exportQif(records, sourceId);
  const name = csvFileName(sourceId);
  const decimal = $('#csv-decimal')?.value === ',' ? ',' : '.';
  triggerDownload(new Blob([recordsToCsv(records, { decimal })], { type: 'text/csv;charset=utf-8' }), name);
  $('#summary').textContent = t('store_export_done', [String(records.length), name]);
}

// QIF: bank movements and investment operations in their own sections. A record whose investment operation
// cannot be identified is left out — guessing Buy vs Sell would corrupt a portfolio — so the count of what
// was dropped is reported next to the count of what was written, never swallowed.
function exportQif(records, sourceId) {
  const { text, exported, skipped } = recordsToQif(records, { dateOrder: $('#qif-date')?.value === 'MDY' ? 'MDY' : 'DMY' });
  if (!exported) { alert(t('store_export_qif_none', [String(skipped)])); return; }
  const name = qifFileName(sourceId);
  triggerDownload(new Blob([text], { type: 'application/qif;charset=utf-8' }), name);
  $('#summary').textContent = t('store_export_done', [String(exported), name])
    + (skipped ? ' — ' + t('store_export_qif_skipped', [String(skipped)]) : '');
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
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
  if (src && src.items) { for (const id of ids) delete src.items[String(id)]; await backend.saveSource(sourceId, src, { prune: true }); } // explicit inspector delete
  await render();
}

async function onClearSource() {
  const sourceId = $('#source').value;
  if (!backend || !sourceId) return;
  if (!confirm(`Vaciar TODO el almacén de «${sourceId}»? Se borran todos sus registros. No se puede deshacer.`)) return;
  const src = await backend.loadSource(sourceId);
  await backend.saveSource(sourceId, { ...emptySource((src && src.meta) || {}), items: {} }, { prune: true }); // explicit clear-all
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
