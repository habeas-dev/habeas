import { chrome } from '../lib/ext.js';
import { applyI18n, t } from '../lib/i18n.js';
import { startLearning, stopLearning, getSamples, clearSamples, getAuthFor, getSeen, getAssets } from '../lib/learn.js';
import { draftAdapterFromSamples, listCandidates, matchCandidates } from '../runtime/infer.js';
import { listInventory } from '../runtime/inventory.js';
import { validateAdapter } from '../adapters/validate.js';
import { saveSource } from '../adapters/index.js';
import { grantConsent } from '../lib/consent.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => (typeof n === 'number' ? n.toFixed(2) : n ?? '');
let LEARN = null;         // { domain, origin }
let candidates = [];      // detected source field paths
let SAMPLES = [];         // captured response samples
let ASSETS = [];          // captured document (PDF) requests
let CANDS = [];           // candidate document lists across the samples
let DRAFT = null;         // the inferred adapter draft (form edits are merged onto this)

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
  SAMPLES = samples;
  ASSETS = await getAssets(LEARN.domain);
  CANDS = listCandidates(samples);
  if (!CANDS.length) { $('#status').textContent = t('author_no_list'); return; }
  // Let the user pick which captured list is their data (biggest is only a default).
  $('#f_list').innerHTML = CANDS.map((c, i) => `<option value="${i}">${c.count} · ${esc(c.path)} · ${esc(c.host)}</option>`).join('');
  $('#f_list').onchange = () => drawDraft(CANDS[+$('#f_list').value]);
  $('#findbtn').onclick = onFind;
  $('#f_find').onkeydown = (e) => { if (e.key === 'Enter') onFind(); };
  $('#listpickrow').hidden = CANDS.length <= 1;
  $('#findstatus').textContent = '';
  $('#mapper').hidden = false;
  drawDraft(CANDS[0]);
}

// Search: the user types a value they recognise (ticket no., amount…) → jump to the list that has it.
function onFind() {
  const q = $('#f_find').value.trim();
  if (!q) return;
  const matches = matchCandidates(SAMPLES, q);
  if (!matches.length) { $('#findstatus').textContent = t('author_find_none'); return; }
  const i = CANDS.findIndex((c) => c.key === matches[0].key);
  if (i >= 0) { $('#f_list').value = String(i); drawDraft(CANDS[i]); }
  if (matches.length > 1) { $('#listpickrow').hidden = false; $('#findstatus').textContent = t('author_find_multi', [String(matches.length)]); }
  else $('#findstatus').textContent = t('author_find_ok', [String(matches[0].count)]);
}

function drawDraft(chosen) {
  const r = draftAdapterFromSamples(SAMPLES, { domain: LEARN.domain, pageHost: hostFromOrigin(LEARN.origin), assets: ASSETS }, { key: chosen.key });
  if (!r.ok) { $('#status').textContent = t('author_no_list'); return; }
  DRAFT = r.draft;
  candidates = r.fieldCandidates; // [{ path, value }]
  fillForm(DRAFT);
  const doc = DRAFT.api.detail ? t('doc_json') : DRAFT.api.pdf ? t('doc_pdf') : t('doc_none');
  $('#status').textContent = t('author_detected', [r.itemsPath, String(r.count)]) + ' · ' + doc;
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
  $('#f_detail').value = (d.api && d.api.detail && d.api.detail.path) || '';
  $('#f_schema').value = d.schema || 'receipt@1';
  $('#f_cats').value = (d.categories || []).join(',');
  renderFieldMap(d.fields || {});
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

// Start from the inferred draft and apply only the user's edits — this preserves the inferred
// pagination, detail/PDF endpoint, replayHeaders, match/domain, etc.
function buildAdapter() {
  const a = JSON.parse(JSON.stringify(DRAFT || {}));
  a.id = $('#f_id').value.trim();
  a.name = $('#f_name').value.trim();
  a.schema = $('#f_schema').value;
  const cats = $('#f_cats').value.split(',').map((s) => s.trim()).filter(Boolean);
  a.categories = cats.length ? cats : ['other'];
  a.fields = collectFields();
  a.api = a.api || {};
  a.api.host = $('#f_host').value.trim();
  a.api.list = a.api.list || {};
  a.api.list.path = $('#f_path').value.trim();
  a.api.list.itemsPath = $('#f_items').value.trim();
  a.api.list.paging = $('#f_paging').value;
  // Advanced overrides for the per-document artifact.
  const pdfPath = $('#f_pdf').value.trim();
  const detailPath = $('#f_detail').value.trim();
  if (pdfPath) a.api.pdf = { ...(a.api.pdf || {}), path: pdfPath, method: (a.api.pdf && a.api.pdf.method) || 'GET' };
  else if (!pdfPath && !detailPath && a.api.pdf === undefined) { /* nothing */ }
  if (detailPath) a.api.detail = { ...(a.api.detail || {}), path: detailPath, method: (a.api.detail && a.api.detail.method) || 'GET' };
  else if (!detailPath && a.api.detail) delete a.api.detail;
  a.trust = 'community';
  return a;
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
