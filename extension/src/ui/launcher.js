// Habeas — the POPUP is a pure launcher: a quick hero into the Archive, Sync-all, and links to the Advanced
// tools + Settings. The classic Sources/Documents UI lives in its own tab (advanced.html), the activity log in
// activity.html — the popup itself only jumps you into those.
import { chrome } from '../lib/ext.js';
import { getConfig } from '../lib/config.js';
import { getAdapters } from '../adapters/index.js';
import { listSources } from '../lib/store.js';
import { applyI18n, t } from '../lib/i18n.js';
import { esc } from '../lib/esc.js';
import { watchThemeIcon } from '../lib/theme-icon.js';

const $ = (s) => document.querySelector(s);
let ADAPTERS = {};
const openTab = (page) => chrome.tabs.create({ url: chrome.runtime.getURL(page) });

// The last status message, shown in the topbar. Fed live from the background's habeas:status.
function setTopStatus(msg) { const el = $('#topstatus'); if (el) el.textContent = msg || ''; }

// The hero: one chip per source you can open in the Archive (stored ones + every enabled installed datasource),
// plus a CTA that opens the whole Archive. Cheap — only reads the store's source keys + config.
async function renderQuick() {
  const el = $('#quick'); if (!el) return;
  let keys = []; try { keys = await listSources(); } catch (e) {}
  const cfg = await getConfig().catch(() => ({ datasources: [] }));
  const storeBases = keys.map((k) => String(k).split(':')[0]);
  const cfgBases = (cfg.datasources || []).filter((d) => d.enabled !== false && ADAPTERS[d.adapter]).map((d) => d.adapter);
  const bases = [...new Set([...storeBases, ...cfgBases])];
  const open = (src) => openTab('src/ui/archive.html' + (src ? '?src=' + encodeURIComponent(src) : ''));
  const chips = bases.slice(0, 12).map((b) => { const a = ADAPTERS[b]; return `<button class="q-chip" data-arch="${esc(b)}">🗂️ ${esc((a && a.name) || b)}</button>`; }).join('');
  const sub = bases.length ? t('quick_sub', [String(bases.length)]) : t('quick_sub_empty');
  el.innerHTML = `<div class="q-head"><div><div class="q-title">${esc(t('archive_index_title'))}</div><div class="q-sub">${esc(sub)}</div></div><button class="primary q-cta" id="q-open">${esc(t('open_archive'))} →</button></div>${chips ? `<div class="q-chips">${chips}</div>` : ''}`;
  el.hidden = false;
  $('#q-open').onclick = () => open('');
  el.querySelectorAll('[data-arch]').forEach((x) => { x.onclick = () => open(x.dataset.arch); });
}

// "Sync all now": sweep every auto route. Status shows in the topbar; live per-source progress arrives via the
// permanent habeas:status listener below.
async function onSyncAll() {
  const b = $('#sync-all');
  b.textContent = t('stop'); b.onclick = () => chrome.runtime.sendMessage({ type: 'habeas:sync-stop' }); // click again to stop
  setTopStatus(t('sync_all_running'));
  try {
    const r = await chrome.runtime.sendMessage({ type: 'habeas:sync-all' });
    if (r && r.ok && (r.status === 'done' || r.status === 'stopped')) {
      let msg = (r.status === 'stopped' ? t('sync_all_stopped') + ' · ' : '') + t('sync_all_done', [String(r.new || 0), String(r.sources || 0)]);
      if (r.needLogin) msg += ' · ' + t('sync_all_needlogin', [String(r.needLogin)]);
      if (r.noSink) msg += ' · ' + t('sync_all_nosink', [String(r.noSink)]);
      setTopStatus(msg);
    } else if (r && r.status === 'busy') { setTopStatus(t('sync_all_running')); }
    else { setTopStatus(t('sync_all_err', [(r && r.error) || 'error'])); }
  } catch (e) { setTopStatus(t('sync_all_err', [(e && e.message) || String(e)])); }
  finally { b.textContent = t('sync_all'); b.onclick = onSyncAll; }
}

async function init() {
  applyI18n();
  try { const v = $('#version'); if (v) v.textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) {}
  $('#opts').onclick = () => chrome.runtime.openOptionsPage();
  $('#sync-all').onclick = onSyncAll;
  { const a = $('#open-advanced'); if (a) a.onclick = () => openTab('src/ui/advanced.html'); }
  // A team reply to one of the user's handoffs arrived → surface it (the background poll set the count).
  try { const c = (await chrome.storage.local.get('habeas:contribunread'))['habeas:contribunread'] || 0; const el = $('#contribnotice'); if (el && c > 0) { el.hidden = false; el.onclick = () => chrome.runtime.openOptionsPage(); } } catch (e) {}
  ADAPTERS = await getAdapters();
  await renderQuick();
  watchThemeIcon();
  // Topbar status: seed from the last stored value, then follow the background live.
  try { const s0 = (await chrome.storage.local.get('habeas:status'))['habeas:status']; if (s0 && s0.msg) setTopStatus(s0.msg); } catch (e) {}
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch['habeas:status']) { const v = ch['habeas:status'].newValue; if (v && v.msg) setTopStatus(v.msg); } });
  // A source was (re)installed elsewhere → refresh the chips.
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch['habeas:sources-rev']) getAdapters().then((a) => { ADAPTERS = a; renderQuick().catch(() => {}); }); });
}
init();
