import { chrome } from '../lib/ext.js';
import { getConfig } from '../lib/config.js';
import { listInventory, artifactKinds, fetchArtifact, documentExt } from '../runtime/inventory.js';
import { ensureSiteFetch, recoverSession } from '../lib/pagefetch.js';
import { pickGroup } from './grouppicker.js';
import { renderPage } from '../lib/render.js';
import { writeToSink } from '../sinks/sinks.js';
import { sinkAcceptsSource, acceptsDoc, sinkAcceptsArtifact } from '../sinks/format.js';
import { deliveredSet, markDelivered, getLog, appendLog, getDocMeta, rememberDocMeta } from '../lib/state.js';
import { badgeWorking, badgeClear } from '../lib/badge.js';
import { getHandle, verifyPermission } from '../lib/fs.js';
import { watchThemeIcon } from '../lib/theme-icon.js';
import { applyI18n, t } from '../lib/i18n.js';
import { getAdapters } from '../adapters/index.js';
import { hasConsent } from '../lib/consent.js';
import { loadAuth } from '../lib/authstore.js';
import { recordDelivered, getRecords, countLive, putItems } from '../lib/store.js';
import { outputsOf, resolveOutput, storeKeyOf } from '../lib/outputs.js';

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
  ADAPTERS = await getAdapters();
  const cfg = await getConfig();
  const enabled = cfg.datasources.filter((d) => d.enabled);
  $('#ds').innerHTML = enabled.map((d) => `<option value="${d.id}">${d.id}</option>`).join('') || '<option value="">—</option>';
  populateSinks(cfg);
  renderOutputs(adapterFor($('#ds').value, cfg).adapter);
  if (!enabled.length) $('#status').textContent = t('no_datasources');
  $('#list').onclick = () => onList();
  $('#full-history').onclick = () => onList('full');
  $('#load-store').onclick = onLoadStore;
  $('#send').onclick = onSend;
  $('#sink').onchange = () => render();
  $('#ds').onchange = async () => {
    // Switching source → the previous source's rows are no longer relevant: clear the inventory + surfaces.
    inventory = []; clearLog(); $('#status').textContent = '';
    $('#sendbar').hidden = true; $('#selbar').hidden = true;
    const c = await getConfig(); populateSinks(c); renderOutputs(adapterFor($('#ds').value, c).adapter);
    await render(); refreshStoreButton();
  };
  refreshStoreButton();
  $('#sel-new').onclick = () => setSelection('new');
  $('#sel-all').onclick = () => setSelection('all');
  $('#sel-none').onclick = () => setSelection('none');
  $('#stop').onclick = () => { if (aborter) { aborter.abort(); $('#status').textContent = t('stopping'); } };
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
// Resolve the captured session for this source — merged across sibling hosts sharing its registrable
// domain (a single account JWT often rides several API hosts). Cookie sources get an empty store.
const getAuth = (adapter) => loadAuth(adapter);
// Fill in real date + amount we learned on a past download (source-level meta) for rows whose list only
// exposes a year (e.g. Amazon). Only overrides a missing/year-only value, so a source with real list data
// is untouched.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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

// Build inventory rows from the canonical store's normalized records — no extraction, no session needed.
// Marked _fromStore so send delivers them WITHOUT fetching documents (a projection of what we already have).
const docsFromStore = (records) => records.map((r) => ({
  internalId: r.internalId, record: r, _fromStore: true,
  date: r.date, total: r.total ?? r.amount, type: r.type, returnStatus: r.returnStatus,
  storeName: (r.store && r.store.name) || r.storeName, label: (r.store && r.store.name) || r.issuer || r.counterparty || r.description || '',
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
    for (const d of docsFromStore(await getRecords(sk))) { d._stream = sid; d._storeKey = sk; d._formats = fmts; rows.push(d); }
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
async function onList(mode) {
  clearLog();
  const cfg = await getConfig();
  const { adapter } = adapterFor($('#ds').value, cfg);
  if (!adapter) { $('#status').textContent = t('no_datasources'); return; }
  if (!(await hasConsent(adapter))) { $('#status').textContent = t('needs_consent'); return; }
  const auth = await getAuth(adapter);
  if (!auth) {
    // Bearer source with no captured token yet. Open the site tab ONLY if none is open (don't reload an
    // existing one on every click) so the in-session hook grabs the token as you load/log in, then retry.
    await ensureSiteFetch(adapter, { open: true });
    $('#status').textContent = t('login_in_tab');
    return;
  }
  const sinkId = $('#sink').value;
  const delivered = sinkId ? await deliveredSet($('#ds').value, sinkId) : {};
  const known = await getDocMeta(adapter.id);
  // A source can expose several outputs (streams×formats). List ONCE per stream (formats share the items);
  // the store keys per stream. Each row is tagged with its stream + the selected formats (used on send).
  const outs = selectedOutputs(adapter);
  const streamIds = [...new Set(outs.map((o) => o.stream))];
  const fmtsFor = (sid) => outs.filter((o) => o.stream === sid).map((o) => o.format);
  const key = (d) => (d._stream || '') + '|' + d.internalId;
  const tag = (d, sid, sk) => { d._stream = sid; d._storeKey = sk; d._formats = fmtsFor(sid); return d; };
  const acc = new Map();
  for (const sid of streamIds) { const sk = storeKeyOf(adapter.id, sid); for (const d of docsFromStore(await getRecords(sk))) acc.set(key(tag(d, sid, sk)), d); }
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
      const groupId = await pickGroup(eff, auth, net);
      const baseIds = new Set([...acc.values()].filter((d) => d._stream === sid).map((d) => d.internalId));
      const fresh = await listInventory(eff, auth, net, {
        groupId, signal: aborter.signal, knownIds: mode === 'full' ? null : baseIds,
        onProgress: ({ year, page, docs }) => {
          $('#status').textContent = year != null ? t('listing_year_page', [String(year), String(page), String(docs.length)]) : t('listing_page', [String(page), String(docs.length)]);
          for (const d of docs) acc.set(key(tag(d, sid, sk)), d);
          rebuild(); bars(); render(delivered);
        },
      });
      for (const d of fresh) acc.set(key(tag(d, sid, sk)), d);
      newTotal += fresh.length;
      try { await putItems(sk, fresh.filter((d) => d.internalId != null).map((d) => ({ internalId: d.internalId, record: d.record })), { source: adapter.id, schema: eff.schema }); } catch (e) { /* store best-effort */ }
    }
    rebuild(); await render(delivered); bars();
    $('#status').textContent = aborted() ? t('stopped_n', [String(inventory.length)]) : t('n_listed', [String(inventory.length), String(newTotal)]);
    log(t('n_listed', [String(inventory.length), String(newTotal)]));
  } catch (e) {
    // CSRF / not-logged-in / bad-request (corrupted cookies) → clear cookies if the source opts in and
    // open a clean tab so the user can log in fresh, then retry.
    if (/csrf|4\d\d|5\d\d|forbidden|unauthor|sign ?in|log ?in|session|not logged/i.test(e.message || '')) {
      const cleared = await recoverSession(adapter);
      if (cleared) log(t('cookies_cleared', [String(cleared)]));
      $('#status').textContent = t('login_in_tab');
    } else $('#status').textContent = t('generic_error', [e.message]);
  } finally { busy(false); aborter = null; }
}

async function render(deliveredArg) {
  const dsId = $('#ds').value, sinkId = $('#sink').value;
  // Accept a precomputed delivered-map so incremental (per-page) renders during listing stay synchronous.
  const delivered = deliveredArg || (sinkId ? await deliveredSet(dsId, sinkId) : {});
  $('#tbl tbody').innerHTML = inventory.map((d, i) => {
    const sent = !!delivered[d.internalId];
    return `<tr data-sent="${sent ? '1' : ''}">
       <td><input type="checkbox" data-i="${i}" ${sent ? '' : 'checked'}></td>
       <td>${(d.date || '').slice(0, 10)}</td>
       <td><span class="pill type">${d.type || ''}</span>${d.returnStatus ? ` <span class="pill returned" title="${d.returnStatus}">↩ ${d.returnStatus}</span>` : ''}</td>
       <td>${d.storeName || d.label || d.internalId || ''}</td>
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
    if (d._fromStore) return []; // projection from the store: deliver the record only, no document fetch
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
      for (const d of eligible) {
        if (aborted()) break; // Stop pressed → keep everything saved so far, stop before the next doc
        try {
          const arts = await allArts(d); // every selected format; refines d.date / d.total from the detail
          render(liveDelivered); // show the newly-learned date + amount immediately
          if (!arts.length) noPdf.push(d.internalId);
          const one = new Map(arts.length ? [[d.internalId, arts]] : []);
          const r = await writeToSink(sink, [d], one, { ...opts, source: d._storeKey || adapter.id }); // writes this doc's files + merges its record into the manifest
          written += r.written;
          await markDelivered($('#ds').value, sink.id, [d.internalId]); // durable per doc
          liveDelivered[d.internalId] = 1; render(liveDelivered); // flip the row to "sent"
        } catch (e) { failed.push(d.internalId); log(t('doc_failed', [String(d.internalId), (e && e.message) || String(e)])); }
        $('#status').textContent = t('sending_progress', [String(++i), String(eligible.length)]);
      }
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
      for (const d of eligible) { const sk = d._storeKey || adapter.id; (byStore.get(sk) || byStore.set(sk, []).get(sk)).push(d); }
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
      : t('st_ok', [String(n ?? ''), e.sink || '']);
    return `<div class="activity-item"><span class="when">${when}</span><span class="kind">${e.kind || ''}</span><span>${e.datasource || ''} · ${detail}</span></div>`;
  }).join('') || `<p class="muted">${t('no_activity')}</p>`;
}

init();
