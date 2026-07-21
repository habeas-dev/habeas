// Habeas — the ACTIVITY LOG as its own page (opened in a tab from the Archive/other windows, NOT the popup).
// Reads the delivery/activity log (lib/state.js) and shows it grouped by day. Live-refreshes on new entries.
import { chrome } from '../lib/ext.js';
import { getLog } from '../lib/state.js';
import { applyI18n, t } from '../lib/i18n.js';
import { esc } from '../lib/esc.js';

const $ = (s) => document.querySelector(s);
let ESLANG = false;

const pad = (n) => String(n).padStart(2, '0');
function dayKey(iso) { const d = new Date(iso); if (isNaN(d.getTime())) return ''; return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function dayLabel(key) { const d = new Date(key + 'T00:00:00'); if (isNaN(d.getTime())) return key; return d.toLocaleDateString(ESLANG ? 'es-ES' : 'en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
function timeOf(iso) { const d = new Date(iso); if (isNaN(d.getTime())) return ''; return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

// Same status → label mapping the popup used, so the wording stays consistent.
function detailOf(e) {
  const n = e.new ?? e.count;
  return e.status === 'error' ? t('st_error', [e.error || ''])
    : e.status === 'none' ? t('st_none')
    : e.status === 'nosession' ? t('st_nosession')
    : e.status === 'challenged' ? t('st_challenged')
    : e.status === 'listing' ? t('st_listing')
    : e.status === 'stopped' ? t('st_stopped')
    : t('st_ok', [String(n ?? ''), e.sink || '']);
}
const STATUS_CLASS = { error: 'err', none: 'muted', nosession: 'warn', challenged: 'warn', stopped: 'muted', listing: 'muted' };

async function render() {
  const el = $('#log');
  const entries = await getLog().catch(() => []);
  if (!entries.length) { el.innerHTML = `<div class="empty">${esc(t('no_activity'))}</div>`; return; }
  const days = new Map();
  for (const e of entries) { const k = dayKey(e.t); if (!days.has(k)) days.set(k, []); days.get(k).push(e); }
  let html = '';
  for (const [k, items] of days) {
    html += `<section class="day"><h2>${esc(dayLabel(k))}</h2><ul>`;
    for (const e of items) {
      const cls = STATUS_CLASS[e.status] || 'ok';
      html += `<li class="row ${cls}"><span class="time">${esc(timeOf(e.t))}</span><span class="kind">${esc(e.kind || '')}</span><span class="src">${esc(e.datasource || '')}</span><span class="det">${esc(detailOf(e))}</span></li>`;
    }
    html += '</ul></section>';
  }
  el.innerHTML = html;
}

function init() {
  applyI18n();
  try { document.title = 'Habeas — ' + t('activity'); } catch (e) {}
  try { const L = chrome.i18n.getUILanguage() || 'en'; ESLANG = L.toLowerCase().startsWith('es'); } catch (e) {}
  { const o = $('#opts'); if (o) o.onclick = () => chrome.runtime.openOptionsPage(); }
  render();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch['habeas:log']) render(); });
}
init();
