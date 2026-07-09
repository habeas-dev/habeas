import { chrome } from '../lib/ext.js';
import { getConfig } from '../lib/config.js';
import { listInventory, artifactKinds, fetchArtifact, documentExt } from '../runtime/inventory.js';
import { ensureSiteFetch, recoverSession } from '../lib/pagefetch.js';
import { pickGroup } from './grouppicker.js';
import { renderPage } from '../lib/render.js';
import { writeToSink } from '../sinks/sinks.js';
import { sinkAcceptsSource, acceptsDoc, sinkAcceptsArtifact } from '../sinks/format.js';
import { deliveredSet, markDelivered, getLog, appendLog } from '../lib/state.js';
import { badgeWorking, badgeClear } from '../lib/badge.js';
import { getHandle, verifyPermission } from '../lib/fs.js';
import { watchThemeIcon } from '../lib/theme-icon.js';
import { applyI18n, t } from '../lib/i18n.js';
import { getAdapters } from '../adapters/index.js';
import { hasConsent } from '../lib/consent.js';
import { loadAuth } from '../lib/authstore.js';

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

async function init() {
  applyI18n();
  try { const v = $('#version'); if (v) v.textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) {}
  $('#opts').onclick = () => chrome.runtime.openOptionsPage();
  ADAPTERS = await getAdapters();
  const cfg = await getConfig();
  const enabled = cfg.datasources.filter((d) => d.enabled);
  $('#ds').innerHTML = enabled.map((d) => `<option value="${d.id}">${d.id}</option>`).join('') || '<option value="">—</option>';
  populateSinks(cfg);
  if (!enabled.length) $('#status').textContent = t('no_datasources');
  $('#list').onclick = onList;
  $('#send').onclick = onSend;
  $('#sink').onchange = () => render();
  $('#ds').onchange = async () => { populateSinks(await getConfig()); render(); };
  $('#sel-new').onclick = () => setSelection('new');
  $('#sel-all').onclick = () => setSelection('all');
  $('#sel-none').onclick = () => setSelection('none');
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

async function onList() {
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
  $('#status').textContent = t('listing');
  try {
    const net = await ensureSiteFetch(adapter, { open: true }); // no tab → open the site (session must exist)
    const groupId = await pickGroup(adapter, auth, net); // grouped source → pick which account/card first
    inventory = await listInventory(adapter, auth, net, { groupId });
    await render();
    $('#status').textContent = t('n_documents', [String(inventory.length)]);
    log(t('n_documents', [String(inventory.length)]));
    $('#sendbar').hidden = inventory.length === 0;
    $('#selbar').hidden = inventory.length === 0;
  } catch (e) {
    // CSRF / not-logged-in / bad-request (corrupted cookies) → clear cookies if the source opts in and
    // open a clean tab so the user can log in fresh, then retry.
    if (/csrf|4\d\d|5\d\d|forbidden|unauthor|sign ?in|log ?in|session|not logged/i.test(e.message || '')) {
      const cleared = await recoverSession(adapter);
      if (cleared) log(t('cookies_cleared', [String(cleared)]));
      $('#status').textContent = t('login_in_tab');
    } else $('#status').textContent = t('generic_error', [e.message]);
  }
}

async function render() {
  const dsId = $('#ds').value, sinkId = $('#sink').value;
  const delivered = sinkId ? await deliveredSet(dsId, sinkId) : {};
  $('#tbl tbody').innerHTML = inventory.map((d, i) => {
    const sent = !!delivered[d.internalId];
    return `<tr data-sent="${sent ? '1' : ''}">
       <td><input type="checkbox" data-i="${i}" ${sent ? '' : 'checked'}></td>
       <td>${(d.date || '').slice(0, 10)}</td>
       <td><span class="pill type">${d.type || ''}</span></td>
       <td>${d.storeName || d.label || ''}</td>
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
  await badgeWorking();
  const net = await ensureSiteFetch(adapter, { open: true });
  const kinds = artifactKinds(adapter).filter((k) => sinkAcceptsArtifact(sink, k));
  // Fetch a single doc's artifacts (skip a document kind this doc lacks, e.g. no invoice).
  const fetchArts = async (d) => {
    const arts = [];
    const avail = artifactKinds(adapter, d);
    for (const k of kinds) {
      if (!avail.some((a) => a.kind === k.kind)) continue;
      try { arts.push(await fetchArtifact(adapter, auth, d, net, renderPage, k.kind)); } catch (e) { /* artifact unavailable */ }
    }
    return arts;
  };
  // File-writing sinks persist each document as its own file → save per doc (write + mark delivered as we
  // go) so a long/interrupted run keeps what finished and never re-downloads it. Batch sinks (download =
  // one ZIP, http = one POST) are a single operation → accumulate then write once.
  const streaming = sink.type === 'local-folder' || sink.type === 'drive';
  let written = 0; const noPdf = []; const failed = [];
  try {
    if (streaming) {
      let i = 0;
      for (const d of eligible) {
        try {
          const arts = await fetchArts(d);
          if (!arts.length) noPdf.push(d.internalId);
          const one = new Map(arts.length ? [[d.internalId, arts]] : []);
          const r = await writeToSink(sink, [d], one, opts); // writes this doc's files + merges its record into the manifest
          written += r.written;
          await markDelivered($('#ds').value, sink.id, [d.internalId]); // durable per doc
        } catch (e) { failed.push(d.internalId); log(t('doc_failed', [String(d.internalId), (e && e.message) || String(e)])); }
        $('#status').textContent = t('sending_progress', [String(++i), String(eligible.length)]);
      }
    } else {
      const files = new Map();
      for (const d of eligible) { const arts = await fetchArts(d); if (arts.length) files.set(d.internalId, arts); else noPdf.push(d.internalId); }
      const r = await writeToSink(sink, eligible, files, opts);
      written = r.written;
      await markDelivered($('#ds').value, sink.id, eligible.map((c) => c.internalId));
    }
    const m = t('sent_result', [sink.id, String(written), String(eligible.length), String(noPdf.length)]) + (failed.length ? ' · ' + t('n_failed', [String(failed.length)]) : '') + (skipped ? ' · ' + t('skipped_incompat', [String(skipped)]) : '');
    $('#status').textContent = m; log(m);
    await appendLog({ kind: 'manual', datasource: $('#ds').value, sink: sink.id, status: failed.length ? 'partial' : 'ok', count: eligible.length - failed.length });
    await render();
    await renderActivity();
  } catch (e) {
    const m = t('sink_error', [(e && e.message) || String(e)]);
    $('#status').textContent = m; log(m);
  }
  await badgeClear();
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
