import { chrome } from '../lib/ext.js';
import { getConfig, saveConfig } from '../lib/config.js';
import { manageAccounts } from './accountpicker.js';
import { listInventory, artifactKinds, fetchArtifact, documentExt } from '../runtime/inventory.js';
import { ensureSiteFetch, recoverSession, siteBaseUrl } from '../lib/pagefetch.js';
import { pickGroup } from './grouppicker.js';
import { renderPage, challengeUrlOf } from '../lib/render.js';
import { writeToSink } from '../sinks/sinks.js';
import { sinkAcceptsSource, acceptsDoc, sinkAcceptsArtifact, groupLabelOf, bakeLearned } from '../sinks/format.js';
import { deliveredSet, markDelivered, getLog, appendLog, getDocMeta, rememberDocMeta } from '../lib/state.js';
import { badgeWorking, badgeClear } from '../lib/badge.js';
import { getHandle, verifyPermission } from '../lib/fs.js';
import { watchThemeIcon } from '../lib/theme-icon.js';
import { applyI18n, t } from '../lib/i18n.js';
import { getAdapters } from '../adapters/index.js';
import { hasConsent } from '../lib/consent.js';
import { loadAuth } from '../lib/authstore.js';
import { recordDelivered, getRecords, countLive, putItems, listSources, getSource } from '../lib/store.js';
import { isRetrievable } from '../lib/retrieve.js';
import { outputsOf, resolveOutput, storeKeyOf } from '../lib/outputs.js';
import { esc } from '../lib/esc.js';
import { inventoryView, distinctBy } from '../lib/inventoryview.js';

let ADAPTERS = {};
const $ = (s) => document.querySelector(s);
let inventory = [];
// Inventory view state: filter by group/type (''=all) and sort by a column. Grouped sources (banks with
// several cards/accounts) can narrow to one account; entries can be narrowed/ordered by type too.
let filterGroup = '', filterType = '', sortKey = 'date', sortDir = -1; // date defaults newest-first (dir -1)
const resetView = () => { filterGroup = ''; filterType = ''; sortKey = 'date'; sortDir = -1; };
const log = (m) => { const el = $('#log'); if (el) el.textContent += m + '\n'; console.debug('[Habeas]', m); };
const clearLog = () => { const el = $('#log'); if (el) el.textContent = ''; };
const fmt = (n, cur) => (typeof n === 'number' ? n.toFixed(2) + ' ' + (cur || 'EUR') : (n == null || n === '' ? '' : String(n)));
const localWhen = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso || '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// A single in-flight operation (list / send). The spinner + Stop button reflect it; Stop aborts via a
// shared AbortController that the pager and the per-doc send loop poll.
let aborter = null;
function busy(on) {
  const sp = $('#spin'), stop = $('#stop'); if (sp) sp.hidden = !on; if (stop) stop.hidden = !on;
  const l = $('#list'), s = $('#send'); if (l) l.disabled = on; if (s) s.disabled = on;
}
const aborted = () => !!(aborter && aborter.signal.aborted);

async function init() {
  applyI18n();
  try { const v = $('#version'); if (v) v.textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) {}
  $('#opts').onclick = () => chrome.runtime.openOptionsPage();
  $('#sync-all').onclick = onSyncAll;
  ADAPTERS = await getAdapters();
  const cfg = await getConfig();
  const enabled = cfg.datasources.filter((d) => d.enabled);
  $('#ds').innerHTML = enabled.map((d) => `<option value="${esc(d.id)}">${esc(d.id)}</option>`).join('') || '<option value="">—</option>';
  await populateSinks(cfg);
  renderOutputs(adapterFor($('#ds').value, cfg).adapter);
  if (!enabled.length) $('#status').textContent = t('no_datasources');
  $('#list').onclick = () => onList();
  $('#full-history').onclick = () => onList('full');
  $('#accounts').onclick = onManageAccounts;
  refreshAccountsBtn(cfg);
  $('#load-store').onclick = onLoadStore;
  $('#send').onclick = onSend;
  $('#sink').onchange = async () => { await setFavSink($('#ds').value, $('#sink').value); render(); }; // remember this source's preferred sink
  $('#ds').onchange = async () => {
    // Switching source → the previous source's rows are no longer relevant: clear the inventory + surfaces.
    inventory = []; resetView(); clearLog(); $('#status').textContent = '';
    $('#sendbar').hidden = true; $('#selbar').hidden = true; $('#filterbar').hidden = true;
    const c = await getConfig(); await populateSinks(c); renderOutputs(adapterFor($('#ds').value, c).adapter);
    await render(); refreshStoreButton(); refreshAccountsBtn(c);
  };
  refreshStoreButton();
  $('#sel-new').onclick = () => setSelection('new');
  $('#sel-all').onclick = () => setSelection('all');
  $('#sel-none').onclick = () => setSelection('none');
  $('#filter-group').onchange = () => { filterGroup = $('#filter-group').value; render(); };
  $('#filter-type').onchange = () => { filterType = $('#filter-type').value; render(); };
  document.querySelectorAll('#tbl th.sortable').forEach((th) => { th.onclick = () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = k === 'date' ? -1 : 1; } // date newest-first, group/type A→Z
    render();
  }; });
  $('#stop').onclick = () => { if (aborter) { aborter.abort(); $('#status').textContent = t('stopping'); } };
  await badgeClear();
  watchThemeIcon();
  wireDocsTab();
  await renderActivity();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch['habeas:log']) renderActivity(); });
  await resumePendingList(); // a list left pending on login resumes automatically once the session is captured
}

function adapterFor(dsId, cfg) {
  const ds = cfg.datasources.find((d) => d.id === dsId);
  return { ds, adapter: ds && ADAPTERS[ds.adapter] };
}

// Does a stored doc's account (its group label) pass the datasource's account filter? A saved filter
// (ds.groupLabels) hides other accounts' already-stored docs from the views. Docs with NO group (a
// non-account output, e.g. the integrated monthly statement) are always allowed.
function groupAllowed(ds, group) {
  const labels = ds && ds.groupLabels;
  return !(labels && labels.length) || !group || labels.includes(group);
}

// The deliverable FILE formats for a store key's stream: [{ id, ext, name }] — empty when the stream is
// record-only (a bank movement has no per-item file, only its manifest record). A statement stream may
// have several (PDF + Excel). Used to decide whether a "delivered" badge is openable (and offer each file).
function fileFormatsFor(adapter, streamId) {
  if (!adapter) return [];
  if (!adapter.streams || !adapter.streams.length) {
    return artifactKinds(adapter).filter((k) => k.kind === 'document').map((k) => ({ id: '', ext: k.ext, name: (k.ext || 'file').toUpperCase() }));
  }
  const s = adapter.streams.find((x) => x.id === streamId);
  if (!s) return [];
  const formats = (s.formats && s.formats.length) ? s.formats : [{ id: '', name: '' }];
  const out = [];
  for (const f of formats) {
    const eff = resolveOutput(adapter, s.id + (f.id ? '/' + f.id : ''));
    const doc = artifactKinds(eff).find((k) => k.kind === 'document');
    if (doc) out.push({ id: f.id, ext: doc.ext, name: f.name || (doc.ext || 'file').toUpperCase() });
  }
  return out;
}

// The effective GROUPED adapter for a source: the base if it declares api.groups, else the first stream
// that does — a streamed source (ING) declares api.groups per stream, not at the top level. null = not grouped.
function groupedAdapterOf(adapter) {
  if (!adapter) return null;
  if (adapter.api && adapter.api.groups) return adapter;
  for (const s of adapter.streams || []) { const eff = resolveOutput(adapter, s.id); if (eff.api && eff.api.groups) return eff; }
  return null;
}

// The "Accounts" button only makes sense for a grouped source (a bank with several accounts/cards).
function refreshAccountsBtn(cfg) {
  const btn = $('#accounts'); if (!btn) return;
  const { adapter } = adapterFor($('#ds').value, cfg);
  btn.hidden = !groupedAdapterOf(adapter);
}

// Persistent account filter: enumerate the source's accounts, let the user check which to import, and SAVE
// the allow-list on the datasource (ds.groups). Listing/auto/sweep then only ever touch the chosen accounts.
async function onManageAccounts() {
  const cfg = await getConfig();
  const { ds, adapter } = adapterFor($('#ds').value, cfg);
  const gAdapter = groupedAdapterOf(adapter);           // has api.groups (base or a stream) — used to enumerate
  if (!gAdapter) return;
  if (!(await hasConsent(adapter))) { $('#status').textContent = t('needs_consent'); return; }
  const auth = await getAuth(adapter);
  if (!auth) { // no captured session yet → open the login tab so the token is captured, then retry
    await ensureSiteFetch(adapter, { open: true });
    $('#status').textContent = t('login_wait');
    return;
  }
  $('#status').textContent = t('accounts_loading');
  // Do NOT open a foreground tab here: it steals focus and CLOSES the popup, taking the account dialog with
  // it. Reuse an already-open site tab if there is one; otherwise pass null so listGroups fetches directly
  // from the extension (host permission → no CORS; auth.cookies:false → no oversized-cookie 413).
  let net; try { net = await ensureSiteFetch(adapter, { open: false }); } catch (e) {}
  let selected;
  try { selected = await manageAccounts(gAdapter, auth, net, (ds && ds.groups) || null); }
  catch (e) { $('#status').textContent = t('accounts_failed') + (e && e.message ? ' — ' + e.message : ''); return; }
  if (selected == null) { $('#status').textContent = ''; return; } // cancelled
  const c = await getConfig();
  const d = c.datasources.find((x) => x.id === $('#ds').value);
  if (d) {
    d.groups = selected.map((g) => String(g.id));                          // ids → restrict listing/auto/sweep
    d.groupLabels = selected.map((g) => groupLabelOf(g)).filter(Boolean);  // labels (= record.group) → hide other accounts' stored docs
    await saveConfig(c);
  }
  $('#status').textContent = t('accounts_saved', [String(selected.length)]);
}
// Auto-resume listing after login: when List is clicked with no captured session, we open the login tab
// and want to list AUTOMATICALLY once the token is captured. The popup closes when you focus the login tab,
// so we persist a pending marker (re-checked on the NEXT popup open) AND, if the popup stays open, watch
// storage.session live. Bearer sources only (a cookie source's session can't be detected this way).
const PEND_KEY = 'habeas:pendinglist';
async function setPendingList(ds, mode) { try { await chrome.storage.local.set({ [PEND_KEY]: { ds, mode: mode || '' } }); } catch (e) {} }
async function clearPendingList(ds) { try { const o = await chrome.storage.local.get(PEND_KEY); if (o[PEND_KEY] && (!ds || o[PEND_KEY].ds === ds)) await chrome.storage.local.remove(PEND_KEY); } catch (e) {} }
let __authWatch = null;
function watchAuthResume(adapter, mode) {
  if (__authWatch) { try { chrome.storage.onChanged.removeListener(__authWatch); } catch (e) {} __authWatch = null; }
  __authWatch = async (ch, area) => {
    if (area !== 'session') return; // token captures live in storage.session
    if (await getAuth(adapter)) { try { chrome.storage.onChanged.removeListener(__authWatch); } catch (e) {} __authWatch = null; await clearPendingList($('#ds').value); onList(mode, { resumed: true }); }
  };
  chrome.storage.onChanged.addListener(__authWatch);
}
// On popup open: if a list was left pending (user went to log in) and the session is now captured, resume it.
async function resumePendingList() {
  let p; try { p = (await chrome.storage.local.get(PEND_KEY))[PEND_KEY]; } catch (e) {}
  if (!p || !p.ds) return;
  const cfg = await getConfig(); const { adapter } = adapterFor(p.ds, cfg);
  if (!adapter) { await clearPendingList(); return; }
  // Bearer: resume only once the token is captured (getAuth truthy). Cookie: no token to detect → just
  // retry; the list itself reveals whether the login took, and a still-failing retry re-arms silently.
  const cookie = adapter.auth && adapter.auth.mode === 'cookie';
  if (cookie || await getAuth(adapter)) {
    await clearPendingList();
    $('#ds').value = p.ds; await populateSinks(cfg); renderOutputs(adapter); refreshStoreButton();
    onList(p.mode || undefined, { resumed: true });
  }
}

// Per-source preferred sink: remember the sink last chosen for a source and default to it next time
// (instead of always the first). Stored in storage.local, keyed by datasource id.
const FAV_KEY = 'habeas:favsink';
async function getFavSinks() { try { const o = await chrome.storage.local.get(FAV_KEY); return o[FAV_KEY] || {}; } catch (e) { return {}; } }
async function setFavSink(dsId, sinkId) { if (!dsId || !sinkId) return; const f = await getFavSinks(); if (f[dsId] === sinkId) return; f[dsId] = sinkId; try { await chrome.storage.local.set({ [FAV_KEY]: f }); } catch (e) {} }

// Only offer sinks that accept this data source (by category / source allowlist); default to the source's
// remembered favorite when it is still offered.
async function populateSinks(cfg) {
  const dsId = $('#ds').value;
  const { adapter } = adapterFor(dsId, cfg);
  const list = cfg.sinks.filter((s) => !adapter || sinkAcceptsSource(s, adapter));
  $('#sink').innerHTML = list.map((s) => `<option value="${esc(s.id)}">${esc(s.id)} · ${esc(s.type)}</option>`).join('') || '<option value="">—</option>';
  const fav = (await getFavSinks())[dsId];
  const def = await getDefaultSink();
  const pick = (fav && list.some((s) => s.id === fav) && fav) || (def && list.some((s) => s.id === def) && def);
  if (pick) $('#sink').value = pick; // this source's favorite → the global default → (else) first compatible
}
async function getDefaultSink() { try { return (await chrome.storage.local.get('habeas:defaultsink'))['habeas:defaultsink'] || ''; } catch (e) { return ''; } }
// Resolve the captured session for this source — merged across sibling hosts sharing its registrable
// domain (a single account JWT often rides several API hosts). Cookie sources get an empty store.
const getAuth = (adapter) => loadAuth(adapter);
// Fill in real date + amount we learned on a past download (source-level meta) for rows whose list only
// exposes a year (e.g. Amazon). Only overrides a missing/year-only value, so a source with real list data
// is untouched.

// A source with several outputs (streams×formats) shows a checkbox per output (default ALL checked) so the
// user picks which to obtain; hidden for single-output sources.
function renderOutputs(adapter) {
  const box = $('#outputs'); if (!box) return;
  const outs = adapter ? outputsOf(adapter) : [];
  if (outs.length <= 1) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<span class="muted">${t('outputs_label')}</span>` + outs.map((o) =>
    `<label style="display:inline-flex;align-items:center;gap:5px"><input type="checkbox" data-out="${esc(o.id)}" checked>${esc(o.name)}</label>`).join('');
}
function selectedOutputs(adapter) {
  const outs = outputsOf(adapter);
  if (outs.length <= 1) return outs;
  const checked = [...document.querySelectorAll('#outputs input[data-out]:checked')].map((c) => c.dataset.out);
  const picked = outs.filter((o) => checked.includes(o.id));
  return picked.length ? picked : outs;
}

// Attachable files for a row: one entry per artifact format the doc's stream can produce (PDF/XLS/JSON…),
// with `ok` = whether THIS item actually has it (records-only streams → none; a retention-limited PDF may be
// absent). Precomputed per doc (see tag()/onLoadStore) so render() stays cheap.
const FILE_ICON = { pdf: '📄', xls: '📊', xlsx: '📊', csv: '📊', json: '🧾', xml: '🧾', html: '🌐', zip: '🗜️' };
function fileInfo(adapter, d) {
  const stream = d._stream || '';
  const outs = outputsOf(adapter).filter((o) => o.stream === stream);
  const seen = new Set(); const out = [];
  for (const o of outs) {
    const eff = resolveOutput(adapter, o.id);
    const can = artifactKinds(eff);      // artifacts this output CAN produce (source-level)
    const has = artifactKinds(eff, d);   // artifacts THIS doc can produce (fields present)
    for (const k of can) {
      const ext = String(k.ext || 'file').toLowerCase();
      if (seen.has(ext)) continue; seen.add(ext);
      out.push({ ext, ok: has.some((a) => a.kind === k.kind) });
    }
  }
  return out;
}
// Badges "📄 PDF · 📊 XLS…" for the Formats column; a faint badge = the format exists but not for this item.
function renderFiles(d) {
  const files = d._files || [];
  return files.map((f) => `<span class="pill file${f.ok ? '' : ' faint'}"${f.ok ? '' : ` title="${esc(t('file_unavailable'))}"`}>${FILE_ICON[f.ext] || '📄'} ${esc(f.ext.toUpperCase())}</span>`).join(' ');
}
// Friendly label for the account/card a row belongs to (grouped sources: banks with several cards).
// Freshly-listed docs carry the full _group object; rows loaded from the store carry the persisted
// `group` label on their record (see buildRecord) — surfaced as d.group by docsFromStore.
function groupLabel(d) {
  if (d && d._group) return groupLabelOf(d._group);
  return (d && d.group) || '';
}
// The stream's display name (e.g. "Extractos"), used as a readable fallback label for rows whose records
// carry no descriptive field — so a statement shows "Extractos" instead of its opaque internalId.
const streamNameOf = (adapter, sid) => ((adapter && adapter.streams || []).find((s) => s.id === sid) || {}).name || '';

// A record field may be a string OR a nested object ({name,address} for an invoice issuer / receipt store).
// Pull a display string so the table never shows "[object Object]".
const nameOf = (v) => (v && typeof v === 'object') ? (v.name || v.nombre || v.descripcion || '') : (v == null ? '' : String(v));
// Build inventory rows from the canonical store's normalized records — no extraction, no session needed.
// Marked _fromStore so send delivers them WITHOUT fetching documents (a projection of what we already have).
const docsFromStore = (records) => records.map((r) => ({
  internalId: r.internalId, record: r, _fromStore: true,
  date: r.date, total: r.total ?? r.amount, currency: r.currency, type: r.type, returnStatus: r.returnStatus, group: r.group || '',
  storeName: nameOf(r.store && r.store.name) || nameOf(r.storeName), label: nameOf(r.store && r.store.name) || nameOf(r.issuer) || nameOf(r.counterparty) || nameOf(r.description) || '',
}));

// Show/hide the "Load from store" button for the selected source (only when the store has records for it).
async function refreshStoreButton() {
  const cfg = await getConfig(); const { adapter } = adapterFor($('#ds').value, cfg);
  // Items live per stream store key → sum across the source's streams.
  const streamIds = adapter ? [...new Set(outputsOf(adapter).map((o) => o.stream))] : [];
  let n = 0; for (const sid of streamIds) n += await countLive(storeKeyOf(adapter.id, sid)).catch(() => 0);
  // Both the offline "Load from store" and the "Full history" (re-scan vs the incremental default) only
  // make sense once the store has items for this source; otherwise List already does a full extraction.
  if ($('#load-store')) $('#load-store').hidden = !n;
  if ($('#full-history')) $('#full-history').hidden = !n;
}

// "Sync all now": ask the background to sweep every auto route (unattended first, tab only if a source
// needs its session). One button for "pull whatever's new across all my sources".
async function onSyncAll() {
  const b = $('#sync-all');
  b.textContent = t('stop'); b.onclick = () => chrome.runtime.sendMessage({ type: 'habeas:sync-stop' }); // click again to stop
  $('#status').textContent = t('sync_all_running');
  // Reflect the background's live per-source progress (Listing…/Fetching…/Sending…) while the sweep runs.
  const onStatus = (ch, area) => { const v = area === 'local' && ch['habeas:status'] && ch['habeas:status'].newValue; if (v && v.msg) $('#status').textContent = v.msg; };
  chrome.storage.onChanged.addListener(onStatus);
  try {
    const r = await chrome.runtime.sendMessage({ type: 'habeas:sync-all' });
    if (r && r.ok && (r.status === 'done' || r.status === 'stopped')) {
      let msg = (r.status === 'stopped' ? t('sync_all_stopped') + ' · ' : '') + t('sync_all_done', [String(r.new || 0), String(r.sources || 0)]);
      if (r.needLogin) msg += ' · ' + t('sync_all_needlogin', [String(r.needLogin)]);
      if (r.noSink) msg += ' · ' + t('sync_all_nosink', [String(r.noSink)]);
      $('#status').textContent = msg;
    } else if (r && r.status === 'busy') { $('#status').textContent = t('sync_all_running'); }
    else { $('#status').textContent = t('sync_all_err', [(r && r.error) || 'error']); }
  } catch (e) { $('#status').textContent = t('sync_all_err', [(e && e.message) || String(e)]); }
  finally { chrome.storage.onChanged.removeListener(onStatus); b.textContent = t('sync_all'); b.onclick = onSyncAll; }
}

async function onLoadStore() {
  const cfg = await getConfig(); const { adapter } = adapterFor($('#ds').value, cfg);
  if (!adapter) return;
  const known = await getDocMeta(adapter.id);
  const outs = selectedOutputs(adapter);
  const streamIds = [...new Set(outs.map((o) => o.stream))];
  const fmtsFor = (sid) => outs.filter((o) => o.stream === sid).map((o) => o.format);
  const rows = [];
  for (const sid of streamIds) {
    const sk = storeKeyOf(adapter.id, sid); const fmts = fmtsFor(sid);
    for (const d of docsFromStore(await getRecords(sk))) { d._stream = sid; d._streamName = streamNameOf(adapter, sid); d._storeKey = sk; d._formats = fmts; d._files = fileInfo(adapter, d); rows.push(d); }
  }
  inventory = rows.sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1));
  enrichMeta(inventory, known);
  await render();
  $('#status').textContent = t('n_from_store', [String(inventory.length)]);
  $('#sendbar').hidden = inventory.length === 0;
  $('#selbar').hidden = inventory.length === 0;
}

const enrichMeta = (docs, known) => {
  for (const d of docs) {
    const k = known[d.internalId]; if (!k) continue;
    if (k.date && !/^\d{4}-\d{2}-\d{2}/.test(d.date || '')) d.date = k.date;
    if (typeof k.total === 'number' && d.total == null) d.total = k.total;
    if (k.returnStatus && !d.returnStatus) d.returnStatus = k.returnStatus;
  }
};

// Merge freshly-enumerated docs into the store base, deduped by internalId (fresh wins), newest first.
const mergeInv = (base, fresh) => {
  const m = new Map(base.map((d) => [d.internalId, d]));
  for (const d of fresh) if (d && d.internalId != null) m.set(d.internalId, d);
  return [...m.values()].sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1));
};

// List = the canonical store shown INSTANTLY + an extraction that fetches only the DELTA (incremental
// early-stop against what we already have). mode 'full' re-enumerates the whole history (reconcile).
async function onList(mode, opts = {}) {
  clearLog();
  const cfg = await getConfig();
  const { ds, adapter } = adapterFor($('#ds').value, cfg);
  if (!adapter) { $('#status').textContent = t('no_datasources'); return; }
  if (!(await hasConsent(adapter))) { $('#status').textContent = t('needs_consent'); return; }
  const auth = await getAuth(adapter);
  if (!auth) {
    // Bearer source with no captured token yet. Open the site tab so the in-session hook grabs the token as
    // you log in, and AUTO-RESUME listing the moment it's captured — no second click. Two paths because the
    // popup closes when you click into the login tab: a live listener (popup still open) + a pending marker
    // re-checked when you reopen the popup (popup closed).
    await ensureSiteFetch(adapter, { open: true });
    $('#status').textContent = t('login_wait');
    await setPendingList($('#ds').value, mode);
    watchAuthResume(adapter, mode);
    return;
  }
  await clearPendingList($('#ds').value); // have a session now → drop any stale "resume after login" marker
  const sinkId = $('#sink').value;
  const delivered = sinkId ? await deliveredSet($('#ds').value, sinkId) : {};
  const known = await getDocMeta(adapter.id);
  // A source can expose several outputs (streams×formats). List ONCE per stream (formats share the items);
  // the store keys per stream. Each row is tagged with its stream + the selected formats (used on send).
  const outs = selectedOutputs(adapter);
  const streamIds = [...new Set(outs.map((o) => o.stream))];
  const fmtsFor = (sid) => outs.filter((o) => o.stream === sid).map((o) => o.format);
  const key = (d) => (d._stream || '') + '|' + d.internalId;
  const tag = (d, sid, sk) => { d._stream = sid; d._streamName = streamNameOf(adapter, sid); d._storeKey = sk; d._formats = fmtsFor(sid); d._files = fileInfo(adapter, d); return d; };
  const acc = new Map();
  for (const sid of streamIds) { const sk = storeKeyOf(adapter.id, sid); for (const d of docsFromStore(await getRecords(sk))) if (groupAllowed(ds, d.group)) acc.set(key(tag(d, sid, sk)), d); }
  const rebuild = () => { inventory = [...acc.values()].sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1)); enrichMeta(inventory, known); };
  const bars = () => { $('#sendbar').hidden = !inventory.length; $('#selbar').hidden = !inventory.length; };
  rebuild(); await render(delivered); bars();
  $('#status').textContent = t('listing');
  aborter = new AbortController();
  busy(true);
  let newTotal = 0;
  try {
    const net = await ensureSiteFetch(adapter, { open: true });
    for (const sid of streamIds) {
      if (aborted()) break;
      const eff = resolveOutput(adapter, sid); const sk = storeKeyOf(adapter.id, sid);
      // A saved account filter (ds.groups) takes over: list ALL selected accounts, no per-list picker.
      // Without one, keep the transient "which account this time?" picker.
      const filter = (ds && ds.groups && ds.groups.length) ? ds.groups : null;
      const groupId = filter ? undefined : await pickGroup(eff, auth, net);
      const baseIds = new Set([...acc.values()].filter((d) => d._stream === sid).map((d) => d.internalId));
      const fresh = await listInventory(eff, auth, net, {
        groupId, groups: filter, signal: aborter.signal, knownIds: mode === 'full' ? null : baseIds,
        onProgress: ({ year, page, docs }) => {
          $('#status').textContent = year != null ? t('listing_year_page', [String(year), String(page), String(docs.length)]) : t('listing_page', [String(page), String(docs.length)]);
          for (const d of docs) acc.set(key(tag(d, sid, sk)), d);
          rebuild(); bars(); render(delivered);
        },
      });
      for (const d of fresh) acc.set(key(tag(d, sid, sk)), d);
      newTotal += fresh.length;
      // Synthetic docs are OPTIMISTIC (every month in the window) — many don't exist (before the account
      // opened). Don't persist them to the store at list time, or "All documents" would mark phantom months
      // as existing files. They still show in THIS list (to pick + download); a successful download/delivery
      // is what proves a month exists and puts it in the store.
      const synthetic = eff.api && eff.api.list && eff.api.list.paging === 'synthetic';
      if (!synthetic) try { await putItems(sk, fresh.filter((d) => d.internalId != null).map((d) => ({ internalId: d.internalId, record: d.record })), { source: adapter.id, schema: eff.schema }); } catch (e) { /* store best-effort */ }
    }
    rebuild(); await render(delivered); bars();
    $('#status').textContent = aborted() ? t('stopped_n', [String(inventory.length)]) : t('n_listed', [String(inventory.length), String(newTotal)]);
    log(t('n_listed', [String(inventory.length), String(newTotal)]));
  } catch (e) {
    // Remember the last list failure so the contributor can report it to the Habeas team in one click
    // (My contributions → Report a problem) without touching DevTools. Redacted before it's ever sent.
    try { await chrome.storage.local.set({ ['habeas:diag:' + adapter.id]: { error: String((e && e.message) || e), at: new Date().toISOString() } }); } catch (_) {}
    // Anti-bot CAPTCHA (DataDome/Cloudflare/Akamai) on the API → SHOW it to the user so they solve it live
    // (the interstitial URL comes back in the response body). Solving it sets the anti-bot cookie; then List
    // again. Checked first, before the generic 4xx/login branch (a challenge is a 403 too).
    const cUrl = challengeUrlOf(e.message || '');
    if (cUrl || /captcha-delivery|datadome|geo\.captcha|challenge-platform|__cf_chl|cf-browser-verification|just a moment|akam[ai]/i.test(e.message || '')) {
      try { await chrome.tabs.create({ url: cUrl || siteBaseUrl(adapter), active: true }); } catch (e2) {}
      $('#status').textContent = t('challenge_solve'); log(t('challenge_solve'));
    } else if (/csrf|4\d\d|5\d\d|forbidden|unauthor|sign ?in|log ?in|session|not logged/i.test(e.message || '')) {
      // A fresh attempt opens/repairs the login tab; a resumed one (auto-retry on popup reopen) must NOT
      // touch the tab — that would reset a half-entered login.
      if (!opts.resumed) { const cleared = await recoverSession(adapter); if (cleared) log(t('cookies_cleared', [String(cleared)])); }
      // Cookie sources capture no token, so there is no storage.session signal to watch — instead ARM the
      // pending marker and retry the list on the next popup open (a still-failing retry re-arms silently).
      if (adapter.auth && adapter.auth.mode === 'cookie') { await setPendingList($('#ds').value, mode); $('#status').textContent = t('login_wait'); }
      else $('#status').textContent = t('login_in_tab');
    } else $('#status').textContent = t('generic_error', [e.message]);
  } finally { busy(false); aborter = null; }
}

const distinctGroups = () => distinctBy(inventory, groupLabel);
const distinctTypes = () => distinctBy(inventory, (d) => d.type);

// Populate + show/hide the group/type filter selects for the current inventory; drop any filter whose value
// no longer exists (e.g. after re-listing a different source). Returns whether the Group column is shown.
function syncFilterControls() {
  const groups = distinctGroups(), types = distinctTypes();
  // Show the Group column (and its filter) only when the list spans ≥2 distinct groups — a single group
  // repeated on every row adds no information. The type filter likewise needs ≥2 distinct types.
  const showGroup = groups.length >= 2, showType = types.length >= 2;
  const fill = (sel, show, opts, cur, allLabel) => {
    if (!sel) return '';
    sel.hidden = !show;
    sel.innerHTML = `<option value="">${esc(t(allLabel))}</option>` + opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
    sel.value = show && opts.includes(cur) ? cur : '';
    return sel.value;
  };
  filterGroup = fill($('#filter-group'), showGroup, groups, filterGroup, 'filter_all_groups');
  filterType = fill($('#filter-type'), showType, types, filterType, 'filter_all_types');
  const fb = $('#filterbar'); if (fb) fb.hidden = !(showGroup || showType);
  return showGroup;
}

function syncSortIndicators() {
  document.querySelectorAll('#tbl th.sortable').forEach((th) => {
    const ind = th.querySelector('.sort-ind');
    if (ind) ind.textContent = th.dataset.sort === sortKey ? (sortDir < 0 ? ' ▼' : ' ▲') : '';
  });
}

const rowHtml = (d, i, delivered) => {
  const sent = !!delivered[d.internalId];
  return `<tr data-sent="${sent ? '1' : ''}">
     <td><input type="checkbox" data-i="${i}" ${sent ? '' : 'checked'}></td>
     <td>${esc((d.date || '').slice(0, 10))}</td>
     <td class="col-group">${esc(groupLabel(d))}</td>
     <td><span class="pill type">${esc(d.type || '')}</span>${d.returnStatus ? ` <span class="pill returned" title="${esc(d.returnStatus)}">↩ ${esc(d.returnStatus)}</span>` : ''}</td>
     <td>${esc(d.storeName || d.label || d._streamName || d.internalId || '')}</td>
     <td class="files">${renderFiles(d)}</td>
     <td class="r">${fmt(d.total ?? d.amount, d.currency || (d.record && d.record.currency))}</td>
     <td>${sent ? `<span class="pill sent" title="${esc(t('pill_sent_hint'))}">${t('pill_sent')}</span>` : `<span class="pill new" title="${esc(t('pill_new_hint'))}">${t('pill_new')}</span>`}</td>
   </tr>`;
};

async function render(deliveredArg) {
  const dsId = $('#ds').value, sinkId = $('#sink').value;
  // Accept a precomputed delivered-map so incremental (per-page) renders during listing stay synchronous.
  const delivered = deliveredArg || (sinkId ? await deliveredSet(dsId, sinkId) : {});
  // Grouped source (a bank with several cards/accounts): show the Group column only when ≥2 distinct groups.
  const showGroup = syncFilterControls();
  const tbl = $('#tbl'); if (tbl) tbl.classList.toggle('has-groups', showGroup);
  // View keeps each row's ORIGINAL inventory index (the checkbox data-i → onSend selection mapping).
  const view = inventoryView(inventory, { filterGroup, filterType, sortKey, sortDir }, groupLabel);
  $('#tbl tbody').innerHTML = view.map(({ d, i }) => rowHtml(d, i, delivered)).join('');
  syncSortIndicators();
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
  const forceRedownload = !!($('#force-redownload') && $('#force-redownload').checked); // re-fetch even store-loaded rows
  // Deliver oldest → newest regardless of the table's display order, so documents are saved (files written,
  // manifest appended) chronologically rather than newest-first.
  const eligible = chosen.filter((d) => acceptsDoc(sink, d))
    .sort((a, b) => ((a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0));
  const skipped = chosen.length - eligible.length;
  if (!eligible.length) { $('#status').textContent = t('none_compatible'); return; }

  const opts = { service: adapter.service || ds.adapter, source: adapter.id, ext: documentExt(adapter) || "pdf" };
  if (sink.type === 'local-folder') {
    const handle = await getHandle('dir:' + sink.id);
    if (!handle) { $('#status').textContent = t('configure_folder'); return; }
    if (!(await verifyPermission(handle))) { $('#status').textContent = t('folder_denied'); return; }
    opts.dirHandle = handle;
  }

  $('#status').textContent = t('fetching', [String(eligible.length)]);
  aborter = new AbortController();
  busy(true);
  await badgeWorking();
  const net = await ensureSiteFetch(adapter, { open: true });
  // A doc belongs to one stream and carries the formats the user selected (`_formats`). Each format
  // resolves to its own effective adapter (its own api.pdf/artifact) — a statement's PDF and Excel are
  // two artifacts of the SAME item. `outFor(d, fmt)` gives the effective adapter for one (stream, format).
  const outFor = (d, fmt) => resolveOutput(adapter, (d._stream || '') + (fmt ? '/' + fmt : ''));
  const formatsOf = (d) => (d._formats && d._formats.length ? d._formats : ['']);
  // Fetch a single doc's artifacts for ONE output (skip a document kind this doc lacks, e.g. no invoice).
  const fetchArts = async (d, eff) => {
    // A store projection delivers the record only — EXCEPT when its record persisted an absolute PDF url
    // (urlField sources like CaixaBank), which can still be fetched (re-validated to the source domain).
    // The "Re-download from site" toggle overrides this: it forces a fresh fetch of PDF + detail (and thus
    // re-bakes the real date/amount) straight from a store-loaded row, without re-listing via Full history.
    if (!forceRedownload && d._fromStore && !(d.record && d.record.pdfUrl)) return [];
    const arts = [];
    const kinds = artifactKinds(eff).filter((k) => sinkAcceptsArtifact(sink, k));
    const avail = artifactKinds(eff, d);
    for (const k of kinds) {
      if (!avail.some((a) => a.kind === k.kind)) continue;
      try { arts.push(await fetchArtifact(eff, auth, d, net, renderPage, k.kind)); } catch (e) { /* artifact unavailable */ }
    }
    // A JSON detail carries the real date + amount that the list may encrypt (Amazon). Adopt them (only
    // over a missing/year-only value) — so file NAMES, the manifest record, and the live table are right.
    for (const a of arts) {
      if (a.ext !== 'json') continue;
      try {
        const r = JSON.parse(await a.blob.text());
        if (/^\d{4}-\d{2}-\d{2}/.test(r.date || '')) { d.date = r.date; if (d.record) d.record.date = r.date; } // detail is authoritative
        if (typeof r.total === 'number') { d.total = r.total; if (d.record) d.record.total = r.total; } // detail wins — the list may hide/encrypt the total, and a stale learned value must not stick (0€ charged ≠ order total)
        if (r.returnStatus) { d.returnStatus = r.returnStatus; if (d.record) d.record.returnStatus = r.returnStatus; } // an item was returned/refunded
      } catch (e) { /* not JSON */ }
      break; // the first JSON detail
    }
    return arts;
  };
  // All artifacts of a doc across its selected formats (a statement's PDF + Excel are both fetched here).
  const allArts = async (d) => { const out = []; for (const fmt of formatsOf(d)) out.push(...await fetchArts(d, outFor(d, fmt))); return out; };
  // File-writing sinks persist each document as its own file → save per doc (write + mark delivered as we
  // go) so a long/interrupted run keeps what finished and never re-downloads it. Batch sinks (download =
  // one ZIP, http = one POST) are a single operation → accumulate then write once.
  const streaming = sink.type === 'local-folder' || sink.type === 'drive';
  let written = 0; const noPdf = []; const failed = [];
  // Live table: fetching a doc's detail reveals its real date + amount (encrypted in Amazon's list) — reflect
  // that in the row AS it downloads, and flip the row to "sent". liveDelivered starts from this sink's ledger.
  const liveDelivered = await deliveredSet($('#ds').value, sink.id);
  try {
    if (streaming) {
      let i = 0;
      // Data-only docs (e.g. card movements — no document file) don't need a per-doc remote write: doing them
      // one at a time re-reads+rewrites the WHOLE manifest once PER movement, which is why a Drive import
      // crawls. Defer them and deliver each stream's records in ONE batched write. Docs WITH a file still go
      // per-doc, so an interrupted long download keeps whatever already uploaded.
      const batch = new Map(); // storeKey → deferred data-only docs
      const flushBatch = async () => {
        for (const [sk, docs] of batch) {
          if (!docs.length) continue;
          try {
            const r = await writeToSink(sink, docs, new Map(), { ...opts, source: sk }); // one manifest merge/write for all records
            written += r.written;
            await markDelivered($('#ds').value, sink.id, docs.map((d) => d.internalId));
            for (const d of docs) liveDelivered[d.internalId] = 1;
          } catch (e) { for (const d of docs) failed.push(d.internalId); log(t('doc_failed', [sk, (e && e.message) || String(e)])); }
        }
        batch.clear();
      };
      for (const d of eligible) {
        if (aborted()) break; // Stop pressed → keep everything saved so far, stop before the next doc
        const sk = d._storeKey || adapter.id;
        try {
          const arts = await allArts(d); // every selected format; refines d.date / d.total from the detail
          if (arts.length) {
            render(liveDelivered); // show the newly-learned date + amount immediately
            const r = await writeToSink(sink, [d], new Map([[d.internalId, arts]]), { ...opts, source: sk }); // this doc's files + its record
            written += r.written;
            await markDelivered($('#ds').value, sink.id, [d.internalId]); // durable per doc
            liveDelivered[d.internalId] = 1; render(liveDelivered); // flip the row to "sent"
          } else { noPdf.push(d.internalId); (batch.get(sk) || batch.set(sk, []).get(sk)).push(d); } // no file → defer to the batched write
        } catch (e) { failed.push(d.internalId); log(t('doc_failed', [String(d.internalId), (e && e.message) || String(e)])); }
        $('#status').textContent = t('sending_progress', [String(++i), String(eligible.length)]);
      }
      await flushBatch();
      render(liveDelivered); // reflect the batched docs as sent
    } else {
      const files = new Map();
      for (const d of eligible) { const arts = await allArts(d); if (arts.length) files.set(d.internalId, arts); else noPdf.push(d.internalId); render(liveDelivered); } // dates/amounts fill in as they download
      const r = await writeToSink(sink, eligible, files, opts);
      written = r.written;
      await markDelivered($('#ds').value, sink.id, eligible.map((c) => c.internalId));
    }
    // Persist the real dates + amounts we learned from the details (source-level) so future listings show them.
    await rememberDocMeta(adapter.id, eligible.map((d) => ({ internalId: d.internalId, date: /^\d{4}-\d{2}-\d{2}/.test(d.date || '') ? d.date : undefined, total: typeof d.total === 'number' ? d.total : undefined, returnStatus: d.returnStatus || undefined })));
    // Write-through to the canonical store: every delivered item's normalized record is recorded once, so a
    // second sink / consumer / device can be served from the store instead of re-extracting (canonical-store.md).
    // Items live per STREAM store key (formats share items) → group and record under each stream's key.
    try {
      const byStore = new Map();
      for (const d of eligible) { const sk = d._storeKey || adapter.id; d.record = bakeLearned(d); (byStore.get(sk) || byStore.set(sk, []).get(sk)).push(d); }
      for (const [sk, docs] of byStore) await recordDelivered(sk, docs, { source: adapter.id, schema: outFor(docs[0], '').schema });
    } catch (e) { /* store is best-effort */ }
    // Does this delivery involve documents at all? A transactions/records-only stream has none BY DESIGN —
    // so "0 PDF, N without PDF" would wrongly read as a failure. Only mention missing documents when the
    // source can actually produce them (then "K without a document" is genuinely informative, e.g. old
    // Amazon tickets with no PDF).
    const expectsDocs = eligible.some((d) => formatsOf(d).some((fmt) => artifactKinds(outFor(d, fmt)).length));
    const head = expectsDocs
      ? t('sent_docs', [sink.id, String(written), String(eligible.length)]) + (noPdf.length ? ' · ' + t('n_nodoc', [String(noPdf.length)]) : '')
      : t('sent_records', [sink.id, String(eligible.length)]);
    const m = (aborted() ? t('stopped') + ' · ' : '') + head + (failed.length ? ' · ' + t('n_failed', [String(failed.length)]) : '') + (skipped ? ' · ' + t('skipped_incompat', [String(skipped)]) : '');
    $('#status').textContent = m; log(m);
    await appendLog({ kind: 'manual', datasource: $('#ds').value, sink: sink.id, status: aborted() ? 'stopped' : (failed.length ? 'partial' : 'ok'), count: written });
    await render();
    await renderActivity();
  } catch (e) {
    const m = t('sink_error', [(e && e.message) || String(e)]);
    $('#status').textContent = m; log(m);
  } finally { await badgeClear(); busy(false); aborter = null; }
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
      : e.status === 'challenged' ? t('st_challenged')
      : e.status === 'listing' ? t('st_listing')
      : e.status === 'stopped' ? t('st_stopped')
      : t('st_ok', [String(n ?? ''), e.sink || '']);
    return `<div class="activity-item"><span class="when">${esc(when)}</span><span class="kind">${esc(e.kind || '')}</span><span>${esc(e.datasource || '')} · ${esc(detail)}</span></div>`;
  }).join('') || `<p class="muted">${t('no_activity')}</p>`;
}

// ==== All-documents browser =============================================================================
// A cross-source view of the canonical store: every recovered document from every source, in one place, no
// backend/sink pickers. Each row shows the REAL date/amount learned at download time (docMeta overlay, e.g.
// Amazon's true date + total) and, per retrievable sink it was delivered to, a badge that opens the file.
let docsRows = null;       // flattened rows, or null = not loaded yet
let docsFiltered = [];     // currently-rendered subset (index target for row handlers)

const sinkLabel = (s) => s.name || s.id || s.type;
const docStore = (r) => nameOf(r.store && r.store.name) || nameOf(r.storeName) || nameOf(r.issuer) || nameOf(r.counterparty) || nameOf(r.description) || '';

function wireDocsTab() {
  $('#tab-sources').onclick = () => switchTab('sources');
  $('#tab-docs').onclick = () => switchTab('docs');
  $('#docs-refresh').onclick = () => renderDocuments();
  $('#docs-search').oninput = renderDocsTable;
  $('#docs-source').onchange = () => { const v = $('#docs-source').value; if (v) loadSourceDocs(v); else clearDocs(); };
  $('#docs-group').onchange = renderDocsTable;
  // Event delegation: one handler for the whole (incrementally-rendered) table, no per-row wiring.
  $('#docs-tbody').onclick = (ev) => {
    const view = ev.target.closest('.doc-view'); if (view) { openDocModal(docsFiltered[+view.dataset.row]); return; }
    const badge = ev.target.closest('.badge-sink'); if (badge && !badge.classList.contains('nofile') && badge.dataset.sink) { const r = docsFiltered[+badge.dataset.row]; openDeliveredFile(r, r.delivered.find((s) => s.id === badge.dataset.sink), badge.dataset.ext); }
  };
  $('#doc-modal-close').onclick = closeDocModal;
  $('#doc-modal .doc-modal-backdrop').onclick = closeDocModal;
}

function clearDocs() {
  docsRows = null; docsFiltered = [];
  $('#docs-tbody').innerHTML = ''; $('#docs-group').hidden = true; $('#docs-status').textContent = '';
}

function switchTab(which) {
  const docs = which === 'docs';
  $('#tab-docs').classList.toggle('active', docs);
  $('#tab-sources').classList.toggle('active', !docs);
  $('#view-docs').hidden = !docs;
  $('#view-sources').hidden = docs;
  if (docs && docsRows === null) renderDocuments();
}

// Overlay the real date/amount/return-status learned when the document detail was fetched (state docMeta).
function enrichRecord(r, k) {
  if (!k) return r;
  const out = { ...r };
  if (k.date && !/^\d{4}-\d{2}-\d{2}/.test(out.date || '')) out.date = k.date;
  if (typeof k.total === 'number' && out.total == null) out.total = k.total;
  if (k.returnStatus && !out.returnStatus) out.returnStatus = k.returnStatus;
  return out;
}

// Populate the source selector ONLY (cheap: just the store keys) — do NOT load any source's items yet, so
// opening the tab is instant even when a source (e.g. Amazon, ~15y) is huge. Items load when a source is picked.
async function renderDocuments() {
  const keys = await listSources();
  const srcs = [...new Set(keys.map((k) => String(k).split(':')[0]))].sort();
  const prev = $('#docs-source').value;
  $('#docs-source').innerHTML = `<option value="">${esc(t('docs_pick_source'))}</option>` + srcs.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  $('#docs-source').value = srcs.includes(prev) ? prev : '';
  if ($('#docs-source').value) await loadSourceDocs($('#docs-source').value);
  else clearDocs();
}

// Load ONE source's documents from the canonical store (only when picked), then render incrementally.
async function loadSourceDocs(base) {
  $('#docs-status').textContent = t('docs_loading');
  const cfg = await getConfig();
  const retrievableSinks = (cfg.sinks || []).filter((s) => isRetrievable(s));
  const ds = cfg.datasources.find((d) => d.adapter === base) || cfg.datasources.find((d) => d.id === base);
  const dsId = (ds && ds.id) || base;                           // delivery ledger is keyed by the DATASOURCE id
  const adapter = (ds && ADAPTERS[ds.adapter]) || ADAPTERS[base] || null;
  const known = await getDocMeta(base).catch(() => ({}));
  const keys = (await listSources()).filter((k) => String(k).split(':')[0] === base);
  const deliveredCache = {};   // "dsId::sinkId" -> delivered set
  const rows = [];
  for (const key of keys) {
    const src = await getSource(key).catch(() => null);
    if (!src || !src.items) continue;
    const stream = String(key).split(':')[1] || '';
    const formats = fileFormatsFor(adapter, stream);   // deliverable file formats for this stream (empty = record-only)
    for (const [internalId, e] of Object.entries(src.items)) {
      if (e.gone) continue;
      const record = enrichRecord(e.record || {}, known[internalId]);
      if (!groupAllowed(ds, record.group)) continue; // respect the saved account filter (hide other accounts)
      const delivered = [];
      for (const sink of retrievableSinks) {
        const ck = dsId + '::' + sink.id;
        const set = deliveredCache[ck] || (deliveredCache[ck] = await deliveredSet(dsId, sink.id).catch(() => ({})));
        if (set[internalId]) delivered.push(sink);
      }
      rows.push({ base, dsId, adapter, internalId, record, delivered, formats });
    }
  }
  rows.sort((a, b) => ((a.record.date || '') < (b.record.date || '') ? 1 : -1)); // newest first
  docsRows = rows;
  populateDocsGroups();
  await renderDocsTable();
}

// Group/account filter for the Documents view — only when the selected source has ≥2 accounts (record.group).
function populateDocsGroups() {
  if (!docsRows) return;
  const src = $('#docs-source').value;
  const groups = [...new Set(docsRows.filter((r) => r.base === src).map((r) => r.record.group).filter(Boolean))].sort();
  const sel = $('#docs-group'); const prev = sel.value;
  sel.hidden = groups.length < 2;
  sel.innerHTML = `<option value="">${esc(t('all_accounts'))}</option>` + groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  sel.value = groups.includes(prev) ? prev : '';
}

function docRowHtml(r, i) {
  const money = esc(fmt(r.record.total ?? r.record.amount, r.record.currency));
  // One badge per (sink × file format). A record-only stream (a bank movement) has no file → the badge is
  // non-clickable (.nofile). A statement stream with PDF+Excel gets one openable badge per format.
  const badges = r.delivered.length
    ? r.delivered.map((s) => (!r.formats.length
      ? `<span class="badge-sink nofile" data-row="${i}" data-sink="${esc(s.id)}" title="${esc(t('delivered_nofile'))}">${esc(sinkLabel(s))}</span>`
      : r.formats.map((f) => `<span class="badge-sink" data-row="${i}" data-sink="${esc(s.id)}" data-ext="${esc(f.ext)}" title="${esc(t('open_from', [sinkLabel(s)]))} · ${esc(f.name)}">${esc(sinkLabel(s))}${r.formats.length > 1 ? ' · ' + esc(f.name) : ''}</span>`).join('')
    )).join('')
    : '<span class="muted">—</span>';
  return `<tr>
      <td>${esc(r.base)}</td>
      <td>${esc((r.record.date || '').slice(0, 10))}</td>
      <td>${esc(docStore(r.record))}${r.record.group ? ' <span class="muted">· ' + esc(r.record.group) + '</span>' : ''}</td>
      <td>${esc(r.record.type || '')}</td>
      <td class="r">${money}</td>
      <td>${badges}</td>
      <td><button class="doc-view" data-row="${i}" title="${esc(t('view'))}">👁</button></td>
    </tr>`;
}

// Render the (filtered) rows in BATCHES, yielding between them, so a large source (thousands of rows) paints
// progressively and never freezes the popup. A render-sequence guard aborts a run superseded by a newer one
// (e.g. the user typed in the search box or switched account) so overlapping renders don't fight.
let docsRenderSeq = 0;
async function renderDocsTable() {
  if (!docsRows) { $('#docs-tbody').innerHTML = ''; return; }
  const seq = ++docsRenderSeq;
  const q = ($('#docs-search').value || '').trim().toLowerCase();
  const srcFilter = $('#docs-source').value;
  const grpFilter = $('#docs-group').value;
  const rows = docsRows.filter((r) => {
    if (srcFilter && r.base !== srcFilter) return false; // exactly one source — never mix
    if (grpFilter && r.record.group !== grpFilter) return false; // filter by account (grouped sources)
    if (!q) return true;
    return [r.base, r.internalId, r.record.date, docStore(r.record), r.record.type].join(' ').toLowerCase().includes(q);
  });
  docsFiltered = rows;
  const tbody = $('#docs-tbody'); tbody.innerHTML = '';
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="7" class="muted">${esc(t('no_documents'))}</td></tr>`; $('#docs-status').textContent = t('n_documents', ['0']); return; }
  const BATCH = 250;
  for (let i = 0; i < rows.length; i += BATCH) {
    if (seq !== docsRenderSeq) return; // superseded by a newer render → stop
    tbody.insertAdjacentHTML('beforeend', rows.slice(i, i + BATCH).map((r, j) => docRowHtml(r, i + j)).join(''));
    $('#docs-status').textContent = t('n_documents', [String(Math.min(i + BATCH, rows.length))]);
    if (i + BATCH < rows.length) await new Promise((res) => setTimeout(res, 0)); // yield → progressive paint
  }
  $('#docs-status').textContent = t('n_documents', [String(rows.length)]);
}

// Generic schematic viewer for a JSON object (record or a retrieved JSON file). Recursive key→value table;
// arrays render as index→value. textContent only (no HTML injection).
function renderKv(obj) {
  const tbl = document.createElement('table'); tbl.className = 'kv';
  const src = Array.isArray(obj) ? obj.reduce((a, v, i) => ((a[i] = v), a), {}) : (obj && typeof obj === 'object' ? obj : { value: obj });
  for (const [k, v] of Object.entries(src)) {
    const tr = document.createElement('tr');
    const th = document.createElement('th'); th.textContent = k; tr.appendChild(th);
    const td = document.createElement('td'); td.className = 'v';
    if (v && typeof v === 'object') td.appendChild(renderKv(v)); else td.textContent = v == null ? '' : String(v);
    tr.appendChild(td); tbl.appendChild(tr);
  }
  return tbl;
}

function closeDocModal() {
  $('#doc-modal').hidden = true;
  $('#doc-modal-body').innerHTML = '';
  $('#doc-modal-actions').innerHTML = '';
}

function openDocModal(row) {
  if (!row) return;
  $('#doc-modal-title').textContent = `${row.base} · ${(row.record.date || '').slice(0, 10)}`;
  const body = $('#doc-modal-body'); body.innerHTML = ''; body.appendChild(renderKv(row.record));
  const actions = $('#doc-modal-actions'); actions.innerHTML = '';
  // One "Open from <sink>" button per retrievable delivery × file format (a record-only movement gets none;
  // a statement with PDF + Excel gets one per format). Opens the real file in a new full-size tab.
  for (const sink of row.delivered) for (const f of (row.formats || [])) {
    const btn = document.createElement('button');
    btn.textContent = t('open_from', [sinkLabel(sink)]) + ((row.formats.length > 1) ? ' · ' + f.name : '');
    btn.onclick = () => openDeliveredFile(row, sink, f.ext);
    actions.appendChild(btn);
  }
  $('#doc-modal').hidden = false;
}

// Open the actual delivered document in a NEW TAB (docview.html re-fetches it there, so the blob URL isn't
// tied to — and revoked by — the popup). PDFs/HTML/images render full-size via the browser's own viewer.
function openDeliveredFile(row, sink, ext) {
  if (!row || !sink) return;
  const url = chrome.runtime.getURL(`src/ui/docview.html?sink=${encodeURIComponent(sink.id)}&src=${encodeURIComponent(row.base)}&id=${encodeURIComponent(row.internalId)}${ext ? '&ext=' + encodeURIComponent(ext) : ''}`);
  chrome.tabs.create({ url });
}

init();
