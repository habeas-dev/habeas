import { chrome } from '../lib/ext.js';
import { applyI18n, t } from '../lib/i18n.js';
import { startLearning, stopLearning, getSamples, clearSamples, getAuthFor, getSeen } from '../lib/learn.js';
import { draftAdapterFromSamples } from '../runtime/infer.js';
import { listInventory } from '../runtime/inventory.js';
import { validateAdapter } from '../adapters/validate.js';
import { saveSource } from '../adapters/index.js';
import { grantConsent } from '../lib/consent.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => (typeof n === 'number' ? n.toFixed(2) : n ?? '');
let LEARN = null;         // { domain, origin }
let candidates = [];      // detected source field paths

// Normalized fields offered per target schema.
const SCHEMA_FIELDS = {
  receipt: ['externalId', 'date', 'total', 'storeName', 'storeAddress', 'type', 'source'],
  invoice: ['externalId', 'date', 'total', 'issuer', 'issuerAddress', 'number', 'type', 'source'],
  transaction: ['externalId', 'date', 'amount', 'description', 'counterparty', 'direction', 'type', 'source'],
  investment: ['externalId', 'date', 'instrument', 'isin', 'units', 'price', 'amount', 'operation', 'type'],
};
// Plain-language labels (i18n keys) for each normalized field — no jargon in the UI.
const FIELD_LABEL = {
  externalId: 'fld_reference', date: 'fld_date', total: 'fld_amount', amount: 'fld_amount',
  storeName: 'fld_store', storeAddress: 'fld_address', issuerAddress: 'fld_address', type: 'fld_type',
  source: 'fld_channel', issuer: 'fld_issuer', number: 'fld_invoicenum', description: 'fld_description',
  counterparty: 'fld_payee', direction: 'fld_direction', instrument: 'fld_instrument', isin: 'fld_isin',
  units: 'fld_units', price: 'fld_price', operation: 'fld_operation',
};
const REQUIRED = new Set(['externalId', 'date']);
const sampleOf = (v) => { const s = String(v ?? ''); return s.length > 26 ? s.slice(0, 26) + '…' : s; };

async function init() {
  applyI18n();
  $('#opts').onclick = () => chrome.runtime.openOptionsPage();
  $('#start').onclick = onStart;
  $('#stop').onclick = onStop;
  $('#analyze').onclick = onAnalyze;
  $('#test').onclick = onTest;
  $('#save').onclick = onSave;
  $('#f_schema').onchange = () => renderFieldMap(collectFields());
  const o = await chrome.storage.local.get('habeas:learn');
  const l = o['habeas:learn'];
  if (l && l.active) { LEARN = { domain: l.domain, origin: l.origin }; showLearning(); }
}

async function onStart() {
  const url = $('#url').value.trim();
  if (!/^https:\/\//.test(url)) { $('#learnstatus').textContent = t('author_bad_url'); return; }
  try {
    LEARN = await startLearning(url);
    showLearning();
  } catch (e) { $('#learnstatus').textContent = t('author_denied'); }
}
function showLearning() {
  $('#start').hidden = true; $('#stop').hidden = false;
  $('#learnstatus').textContent = t('author_learning', [LEARN.domain]);
}
async function onStop() { await stopLearning(); $('#start').hidden = false; $('#stop').hidden = true; $('#learnstatus').textContent = ''; }

async function onAnalyze() {
  if (!LEARN) { $('#learnstatus').textContent = t('author_start_first'); return; }
  const samples = await getSamples(LEARN.domain);
  $('#samplecount').textContent = String(samples.length);
  if (!samples.length) {
    const seen = await getSeen(LEARN.domain);
    const hosts = Object.keys(seen.hosts || {});
    $('#status').textContent = seen.total
      ? t('author_no_list_seen', [String(seen.total), hosts.join(', ')])
      : t('author_no_requests');
    return;
  }
  const r = draftAdapterFromSamples(samples, { domain: LEARN.domain, pageHost: hostFromOrigin(LEARN.origin) });
  if (!r.ok) { $('#status').textContent = t('author_no_list'); return; }
  candidates = r.fieldCandidates; // [{ path, value }]
  fillForm(r.draft);
  $('#mapper').hidden = false;
  $('#status').textContent = t('author_detected', [r.itemsPath, String(r.count)]);
}

function hostFromOrigin(origin) { try { return new URL(origin.replace('/*', '')).host; } catch (e) { return LEARN.domain; } }

function fillForm(d) {
  $('#f_id').value = d.id || '';
  $('#f_name').value = d.name || '';
  $('#f_host').value = (d.api && d.api.host) || '';
  $('#f_path').value = (d.api && d.api.list && d.api.list.path) || '';
  $('#f_items').value = (d.api && d.api.list && d.api.list.itemsPath) || '';
  $('#f_paging').value = (d.api && d.api.list && d.api.list.paging) || 'none';
  $('#f_pdf').value = (d.api && d.api.pdf && d.api.pdf.path) || '';
  $('#f_schema').value = d.schema || 'receipt@1';
  $('#f_cats').value = (d.categories || []).join(',');
  renderFieldMap(d.fields || {});
  // stash paging extras (nextPath/offsetsPath/params/initialOffsets) + detected replayHeaders
  $('#mapper').dataset.extra = JSON.stringify({ ...((d.api && d.api.list) || {}), replayHeaders: (d.auth && d.auth.replayHeaders) || [] });
}

function renderFieldMap(current) {
  const kind = ($('#f_schema').value || 'receipt@1').split('@')[0];
  const fields = SCHEMA_FIELDS[kind] || SCHEMA_FIELDS.receipt;
  // Each option shows the source key plus a real example value, so users pick by recognising data.
  const opt = (sel) => ['<option value=""></option>'].concat(candidates.map((c) =>
    `<option value="${esc(c.path)}" ${c.path === sel ? 'selected' : ''}>${esc(c.path)}${c.value != null && c.value !== '' ? ' — ' + esc(sampleOf(c.value)) : ''}</option>`)).join('');
  $('#fieldmap').innerHTML = fields.map((f) => {
    const label = t(FIELD_LABEL[f] || f) + (REQUIRED.has(f) ? ' *' : '');
    return `<div class="maprow"><label>${esc(label)}</label><select data-field="${esc(f)}">${opt(current[f] || '')}</select></div>`;
  }).join('');
}

function collectFields() {
  const fields = {};
  document.querySelectorAll('#fieldmap [data-field]').forEach((s) => { if (s.value) fields[s.dataset.field] = s.value; });
  return fields;
}

function buildAdapter() {
  const extra = JSON.parse($('#mapper').dataset.extra || '{}');
  const host = $('#f_host').value.trim();
  const domain = LEARN ? LEARN.domain : (host.replace(/^https?:\/\//, '').split('.').slice(-2).join('.'));
  const list = { path: $('#f_path').value.trim(), paging: $('#f_paging').value, itemsPath: $('#f_items').value.trim() };
  if (list.paging === 'cursor') { list.nextPath = extra.nextPath || 'nextCursor'; list.cursorParam = extra.cursorParam || 'cursor'; }
  if (list.paging === 'offsets') { list.offsetsPath = extra.offsetsPath || 'offsets'; list.initialOffsets = extra.initialOffsets || {}; }
  if (extra.params) list.params = extra.params;
  const api = { host, list };
  if ($('#f_pdf').value.trim()) api.pdf = { path: $('#f_pdf').value.trim() };
  const cats = $('#f_cats').value.split(',').map((s) => s.trim()).filter(Boolean);
  const pageHost = LEARN ? hostFromOrigin(LEARN.origin) : host.replace(/^https?:\/\//, '');
  const adapter = {
    id: $('#f_id').value.trim(), name: $('#f_name').value.trim(),
    service: (domain.split('.')[0] || 'source'), trust: 'community', domain,
    categories: cats.length ? cats : ['other'],
    match: ['https://' + pageHost + '/*'],
    auth: { tokenMatch: 'eyJ', replayHeaders: extra.replayHeaders && extra.replayHeaders.length ? extra.replayHeaders : ['authorization'] },
    api, fields: collectFields(), schema: $('#f_schema').value,
  };
  // carry replayHeaders detected during inference (stored on draft.auth) if present
  return adapter;
}

// The API may live on a different host than the login site — request permission to fetch it.
async function ensureHostPermission(hostUrl) {
  try {
    const origin = new URL(hostUrl).origin + '/*';
    if (!(await chrome.permissions.contains({ origins: [origin] }))) await chrome.permissions.request({ origins: [origin] });
  } catch (e) { /* best effort */ }
}

async function onTest() {
  const adapter = buildAdapter();
  const v = validateAdapter(adapter);
  if (!v.ok) { $('#status').textContent = t('author_invalid', [v.errors.join('; ')]); return; }
  await ensureHostPermission(adapter.api.host);
  const host = adapter.api.host.replace(/^https?:\/\//, '');
  const auth = await getAuthFor(host);
  const headers = auth && (auth.byPath[adapter.api.list.path] || auth.merged);
  if (!headers) { $('#status').textContent = t('author_no_auth'); return; }
  $('#status').textContent = t('author_testing');
  try {
    const docs = await listInventory(adapter, headers);
    $('#preview tbody').innerHTML = docs.slice(0, 3).map((d) =>
      `<tr><td>${esc((d.date || '').slice(0, 10))}</td><td>${esc(d.storeName || d.label || '')}</td><td class="r">${esc(fmt(d.total ?? d.amount))}</td><td>${esc(d.type || '')}</td></tr>`).join('');
    $('#status').textContent = t('author_test_ok', [String(docs.length)]);
  } catch (e) { $('#status').textContent = t('author_test_err', [e.message]); }
}

async function onSave() {
  const adapter = buildAdapter();
  const v = validateAdapter(adapter);
  if (!v.ok) { $('#status').textContent = t('author_invalid', [v.errors.join('; ')]); return; }
  try {
    await saveSource(adapter);
    await grantConsent(adapter);       // the author consents to their own source
    await stopLearning();
    $('#status').textContent = t('author_saved', [adapter.id]);
  } catch (e) { $('#status').textContent = t('author_invalid', [e.message]); }
}

init();
