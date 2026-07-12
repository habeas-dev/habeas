import { chrome } from '../lib/ext.js';
import { applyI18n, t } from '../lib/i18n.js';
import { startLearning, stopLearning, getSamples, clearSamples, getAuthFor, getSeen, getAssets, getDomTexts } from '../lib/learn.js';
import { draftAdapterFromSamples, draftStreamsFromSamples, draftWithGroups, listCandidates, matchCandidates } from '../runtime/infer.js';
import { listInventory, artifactKinds, fetchArtifact } from '../runtime/inventory.js';
import { ensureSiteFetch } from '../lib/pagefetch.js';
import { editJson } from './jsoneditor.js';
import { renderPage } from '../lib/render.js';
import { validateAdapter } from '../adapters/validate.js';
import { saveSource } from '../adapters/index.js';
import { grantConsent } from '../lib/consent.js';
import { esc } from '../lib/esc.js';

const $ = (s) => document.querySelector(s);
const fmt = (n) => (typeof n === 'number' ? n.toFixed(2) : n ?? '');
let LEARN = null;         // { domain, origin }
let candidates = [];      // detected source field paths
let SAMPLES = [];         // captured response samples
let TEST_COUNT = 0;       // documents listed in the last Test (for the status line)
let ASSETS = [];          // captured document (PDF) requests
let DOMTEXTS = [];        // rendered page texts (public vs internal id)
let CANDS = [];           // candidate document lists across the samples
let CHOSEN = null;        // the candidate currently drafted as the document list
let GROUPS_KEY = '';      // a candidate marked as the accounts/cards list (multi-account) — '' = none
let DRAFT = null;         // the inferred adapter draft (form edits are merged onto this)

// Normalized fields offered per target schema.
const SCHEMA_FIELDS = {
  receipt: ['internalId', 'number', 'date', 'total', 'storeName', 'storeAddress', 'type', 'source'],
  invoice: ['internalId', 'number', 'date', 'total', 'issuer', 'issuerAddress', 'type', 'source'],
  transaction: ['internalId', 'number', 'date', 'amount', 'description', 'counterparty', 'direction', 'type', 'source'],
  investment: ['internalId', 'number', 'date', 'instrument', 'isin', 'units', 'price', 'amount', 'operation', 'type'],
};
// Plain-language labels (i18n keys) for each normalized field — no jargon in the UI. internalId is
// the INTERNAL id (links detail/PDF, dedup); `number` is the PUBLIC receipt/invoice number.
const FIELD_LABEL = {
  internalId: 'fld_internalid', number: 'fld_number', date: 'fld_date', total: 'fld_amount', amount: 'fld_amount',
  storeName: 'fld_store', storeAddress: 'fld_address', issuerAddress: 'fld_address', type: 'fld_type',
  source: 'fld_channel', issuer: 'fld_issuer', description: 'fld_description',
  counterparty: 'fld_payee', direction: 'fld_direction', instrument: 'fld_instrument', isin: 'fld_isin',
  units: 'fld_units', price: 'fld_price', operation: 'fld_operation',
};
const REQUIRED = new Set(['internalId', 'date']);
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
  $('#editjson').onclick = async () => {
    const edited = await editJson(buildAdapter());
    if (edited) { DRAFT = edited; fillForm(DRAFT); $('#status').textContent = t('json_saved'); }
  };
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
  DOMTEXTS = await getDomTexts(LEARN.domain);
  CANDS = listCandidates(samples);
  if (!CANDS.length) { $('#status').textContent = t('author_no_list'); return; }
  // Let the user pick which captured list is their data (biggest is only a default).
  $('#f_list').innerHTML = CANDS.map((c, i) => `<option value="${i}">${c.count} ${t('author_items')} · ${c.pages} ${t('author_pages')} · ${esc(c.path)} · ${esc(c.host)}</option>`).join('');
  $('#f_list').onchange = () => drawDraft(CANDS[+$('#f_list').value]);
  $('#findbtn').onclick = onFind;
  $('#f_find').onkeydown = (e) => { if (e.key === 'Enter') onFind(); };
  $('#listpickrow').hidden = CANDS.length <= 1;
  $('#listhint').hidden = CANDS.length <= 1;
  $('#findstatus').textContent = '';
  $('#mapper').hidden = false;
  // Multi-stream: if ≥2 captured lists share one registrable domain (Leroy Merlin tickets+orders,
  // WiZink movimientos+extractos), offer to author them together as a streams[] source. Refined in
  // the JSON editor (per-stream field mapping) rather than the single-list form mapper.
  const reg = (h) => String(h || '').split('.').slice(-2).join('.');
  const groups = {};
  CANDS.forEach((c) => { const k = reg(c.host); (groups[k] = groups[k] || []).push(c.key); });
  const msGroup = Object.values(groups).find((g) => g.length >= 2);
  $('#multistream').hidden = !msGroup;
  if (msGroup) $('#multistream').onclick = () => onMultiStream(msGroup);
  // Multi-account: let the user mark one captured list as their accounts/cards → the doc list is then
  // fetched per account (api.groups). Only useful with ≥2 lists; '' = none (a flat, single listing).
  GROUPS_KEY = '';
  $('#groupspickrow').hidden = CANDS.length <= 1;
  $('#f_groups').innerHTML = `<option value="">${t('author_groups_none')}</option>`
    + CANDS.map((c) => `<option value="${esc(c.key)}">${esc(c.path)} · ${esc(c.host)}</option>`).join('');
  $('#f_groups').onchange = () => { GROUPS_KEY = $('#f_groups').value; if (CHOSEN) drawDraft(CHOSEN); };
  drawDraft(CANDS[0]);
}

// Draft every captured list on the domain as a multi-stream source and open it in the JSON editor to
// refine (each stream's field mapping) and save.
async function onMultiStream(keys) {
  const r = draftStreamsFromSamples(SAMPLES, { domain: LEARN.domain, pageHost: hostFromOrigin(LEARN.origin), assets: ASSETS, domTexts: DOMTEXTS }, keys);
  if (!r.ok || !r.draft) { $('#status').textContent = t('author_no_list'); return; }
  const edited = await editJson(r.draft);
  if (!edited) return;
  try {
    await saveSource(edited);
    await grantConsent(edited);
    await stopLearning();
    $('#status').textContent = t('author_saved', [edited.id]);
  } catch (e) { $('#status').textContent = t('author_invalid', [e.message]); }
}

// Search: the user types a value they recognise (ticket no., amount…) → jump to the list that has it.
function onFind() {
  const q = $('#f_find').value.trim();
  if (!q) return;
  const matches = matchCandidates(SAMPLES, q);
  if (!matches.length) { $('#findstatus').textContent = t('author_find_none'); return; }
  const i = CANDS.findIndex((c) => c.key === matches[0].key);
  if (i >= 0) { $('#f_list').value = String(i); drawDraft(CANDS[i]); }
  if (matches.length > 1) { $('#listpickrow').hidden = false; $('#listhint').hidden = false; $('#findstatus').textContent = t('author_find_multi', [String(matches.length)]); }
  else $('#findstatus').textContent = t('author_find_ok', [String(matches[0].count)]);
}

function drawDraft(chosen) {
  CHOSEN = chosen;
  const ctx = { domain: LEARN.domain, pageHost: hostFromOrigin(LEARN.origin), assets: ASSETS, domTexts: DOMTEXTS };
  const r = (GROUPS_KEY && GROUPS_KEY !== chosen.key)
    ? draftWithGroups(SAMPLES, ctx, chosen.key, GROUPS_KEY)
    : draftAdapterFromSamples(SAMPLES, ctx, { key: chosen.key });
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
  // Pass the whole captured store so list/detail/PDF each resolve their own auth (mixed cookie+
  // bearer). Proceed even with nothing captured — cookies (credentials:'include') may carry it.
  const authStore = (await getAuthFor(host)) || { byPath: {}, merged: {} };
  const net = await ensureSiteFetch(adapter, { open: true }); // open the site tab if none → session available
  $('#status').textContent = t('author_testing');
  try {
    const docs = await listInventory(adapter, authStore, net);
    // Show ALL listed documents (not a sample) so the user can confirm pagination pulled everything.
    const MAX_ROWS = 500;
    const rows = docs.slice(0, MAX_ROWS).map((d) =>
      `<tr data-i="${esc(d.internalId)}"><td>${esc((d.date || '').slice(0, 10))}</td><td>${esc(d.storeName || d.label || '')}</td><td class="r">${esc(fmt(d.total ?? d.amount))}</td><td>${esc(d.type || '')}</td></tr>`).join('');
    $('#preview tbody').innerHTML = rows + (docs.length > MAX_ROWS ? `<tr><td colspan="4" class="muted">… +${docs.length - MAX_ROWS}</td></tr>` : '');
    TEST_COUNT = docs.length;
    $('#status').textContent = t('author_test_ok', [String(docs.length)]);
    $('#docwrap').hidden = true;
    // Click any row → test the download/preview of THAT document. Auto-preview the first.
    if (docs.length && artifactKinds(adapter).length) {
      const trs = $('#preview tbody').querySelectorAll('tr[data-i]');
      docs.slice(0, trs.length).forEach((d, i) => { trs[i].onclick = () => previewDoc(adapter, authStore, net, d, trs[i]); });
      previewDoc(adapter, authStore, net, docs[0], trs[0]);
    }
  } catch (e) { $('#status').textContent = t('author_test_err', [e.message]); }
}

// Fetch and preview one specific document (triggered by clicking its row, or auto for the first).
async function previewDoc(adapter, authStore, net, docItem, tr) {
  $('#preview tbody').querySelectorAll('tr.sel').forEach((x) => x.classList.remove('sel'));
  if (tr) tr.classList.add('sel');
  $('#docwrap').hidden = true;
  $('#status').textContent = t('author_test_ok', [String(TEST_COUNT)]) + ' · ' + t('author_doc_fetching', [String(docItem.internalId)]);
  try {
    const kind = artifactKinds(adapter, docItem).some((k) => k.kind === 'document') ? 'document' : 'data'; // per-doc: no invoice → preview the data
    const doc = await fetchArtifact(adapter, authStore, docItem, net, renderPage, kind);
    await showDocPreview(doc);
    $('#status').textContent = t('author_test_ok', [String(TEST_COUNT)]) + ' · ' + t('author_doc_via', [t('via_' + doc.via)]);
  } catch (e) {
    $('#status').textContent = t('author_test_ok', [String(TEST_COUNT)]) + ' · ' + t('author_doc_fail', [(e.message || '').slice(0, 100)]);
  }
}

// Collapsible JSON tree. All keys/values are escaped — the detail is untrusted network data.
function jsonTree(v, key, depth = 0) {
  const label = key != null ? `<span class="tk">${esc(key)}</span>: ` : '';
  if (v === null) return `<div class="tl">${label}<span class="tn">null</span></div>`;
  if (typeof v !== 'object') {
    const cls = typeof v === 'number' ? 'tnum' : typeof v === 'boolean' ? 'tb' : 'ts';
    const shown = typeof v === 'string' ? '"' + (v.length > 200 ? v.slice(0, 200) + '…' : v) + '"' : String(v);
    return `<div class="tl">${label}<span class="${cls}">${esc(shown)}</span></div>`;
  }
  const isArr = Array.isArray(v);
  let entries = isArr ? v.map((x, i) => [i, x]) : Object.entries(v);
  let more = '';
  if (entries.length > 100) { more = `<div class="tl tmeta">… +${entries.length - 100}</div>`; entries = entries.slice(0, 100); }
  const brief = `<span class="tmeta">${isArr ? '[' + v.length + ']' : '{' + Object.keys(v).length + '}'}</span>`;
  const open = depth < 1 ? ' open' : '';
  return `<details${open}><summary>${label}${brief}</summary><div class="tc">${entries.map(([k, x]) => jsonTree(x, k, depth + 1)).join('') + more}</div></details>`;
}

// Preview the fetched document: a collapsible JSON tree for a detail, a size note for a PDF.
async function showDocPreview(doc) {
  const el = $('#docpreview');
  if (doc.ext === 'html') { // render the printable page in a sandboxed iframe (not its source)
    el.innerHTML = '';
    const html = await doc.blob.text();
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', '');
    iframe.style.cssText = 'width:100%;height:340px;border:1px solid var(--line);background:#fff;border-radius:4px';
    iframe.srcdoc = html;
    const toggle = document.createElement('a'); toggle.href = '#'; toggle.textContent = t('view_source'); toggle.style.cssText = 'font-size:12px;display:inline-block;margin-top:4px';
    const pre = document.createElement('pre'); pre.textContent = html; pre.style.cssText = 'display:none;white-space:pre-wrap;max-height:240px;overflow:auto;font-size:11px;margin-top:4px';
    toggle.onclick = (e) => { e.preventDefault(); const show = pre.style.display === 'none'; pre.style.display = show ? 'block' : 'none'; toggle.textContent = t(show ? 'view_rendered' : 'view_source'); };
    el.append(iframe, document.createElement('br'), toggle, pre);
  } else if (doc.ext === 'json') {
    const text = await doc.blob.text();
    let data, ok = true;
    try { data = JSON.parse(text); } catch (e) { ok = false; }
    el.innerHTML = ok ? jsonTree(data) : `<div class="tl">${esc(text.slice(0, 3000))}</div>`;
  } else {
    el.textContent = t('author_doc_pdf_size', [String(Math.max(1, Math.round(doc.blob.size / 1024)))]);
  }
  $('#docwrap').hidden = false;
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
