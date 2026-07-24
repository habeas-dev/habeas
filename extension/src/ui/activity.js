// Habeas — the ACTIVITY LOG as its own page (opened in a tab from the Archive/other windows, NOT the popup).
// Reads the delivery/activity log (lib/state.js) and shows it grouped by day. Live-refreshes on new entries.
import { chrome } from '../lib/ext.js';
import { getLog } from '../lib/state.js';
import { applyI18n, t } from '../lib/i18n.js';
import { esc } from '../lib/esc.js';
import { getAdapters } from '../adapters/index.js';

const $ = (s) => document.querySelector(s);
let ESLANG = false;
let ADAPTERS = {}; // id → adapter, so an error row can name the source + offer a "sign in" link to its site

const pad = (n) => String(n).padStart(2, '0');
function dayKey(iso) { const d = new Date(iso); if (isNaN(d.getTime())) return ''; return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function dayLabel(key) { const d = new Date(key + 'T00:00:00'); if (isNaN(d.getTime())) return key; return d.toLocaleDateString(ESLANG ? 'es-ES' : 'en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
function timeOf(iso) { const d = new Date(iso); if (isNaN(d.getTime())) return ''; return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

const nameOf = (id) => (ADAPTERS[id] && ADAPTERS[id].name) || id || '';
// The source's own site, so an auth error can offer "sign in again" (re-login re-captures the live session).
function siteUrlOf(id) {
  const a = ADAPTERS[id]; if (!a) return '';
  const m = a.openUrl || (a.match && a.match[0]) || '';
  const base = String(m).replace(/^([a-z]+:\/\/[^/]+).*/i, '$1');
  if (base) return base + '/';
  return a.api && a.api.host ? 'https://' + a.api.host + '/' : '';
}

// Same status → label mapping the popup used, for the NON-error rows (kept one-line).
function detailOf(e) {
  const n = e.new ?? e.count;
  return e.status === 'none' ? t('st_none')
    : e.status === 'nosession' ? t('st_nosession')
    : e.status === 'challenged' ? t('st_challenged')
    : e.status === 'listing' ? t('st_listing')
    : e.status === 'stopped' ? t('st_stopped')
    : t('st_ok', [String(n ?? ''), e.sink || '']);
}
const STATUS_CLASS = { error: 'err', none: 'muted', nosession: 'warn', challenged: 'warn', stopped: 'muted', listing: 'muted' };

// A plain-language summary of an error, keyed off the HTTP status the runtime attached (never the raw HTML body).
function humanError(e) {
  const s = Number(e.http) || 0;
  const name = nameOf(e.datasource) || t('this_source');
  if (s === 401 || s === 403) {
    // The runtime told us whether the JWT we replayed had itself expired. A short-lived bank token lapsing (while
    // the browser session lives on) is a DIFFERENT thing from the session ending — and a valid-token 401 is "something else".
    if (e.tokenState === 'expired') return t('log_err_token_expired', [name]);
    if (e.tokenState === 'valid') return t('log_err_auth_valid', [name]);
    return t('log_err_auth', [name]);
  }
  if (s === 404 || s === 406) return t('log_err_gone', [String(s)]);
  if (s >= 500) return t('log_err_server', [String(s)]);
  if (s) return t('log_err_http', [String(s)]);
  return t('log_err_other', [String(e.error || '').replace(/\s+/g, ' ').slice(0, 120)]); // network / non-HTTP
}
// Which request failed: "list · api.host/path · 401" (host+path only — never query string, which may hold ids).
function endpointOf(e) {
  const parts = [];
  if (e.op) parts.push(e.op);
  if (e.url) { try { const u = new URL(e.url); parts.push(u.host + u.pathname); } catch (x) { parts.push(String(e.url).slice(0, 90)); } }
  if (e.http) parts.push(String(e.http));
  return parts.join(' · ');
}

function sig(e) { return [e.status, e.datasource, e.kind, e.http, e.op, e.error].join('|'); }
// Collapse consecutive identical error entries (a flapping auto-sync logs the same 401 many times) into one ×N.
function collapse(items) {
  const out = [];
  for (const e of items) {
    const prev = out[out.length - 1];
    if (prev && prev.status === 'error' && e.status === 'error' && sig(prev) === sig(e)) { prev._count = (prev._count || 1) + 1; continue; }
    out.push({ ...e });
  }
  return out;
}

function rowHtml(e) {
  const head = `<span class="time">${esc(timeOf(e.t))}</span><span class="kind">${esc(e.kind || '')}</span><span class="src">${esc(e.datasource || '')}</span>`;
  if (e.status !== 'error') return `<li class="row ${STATUS_CLASS[e.status] || 'ok'}">${head}<span class="det">${esc(detailOf(e))}</span></li>`;
  const ep = endpointOf(e);
  const site = (Number(e.http) === 401 || Number(e.http) === 403) ? siteUrlOf(e.datasource) : '';
  const count = (e._count && e._count > 1) ? ` <span class="count">×${e._count}</span>` : '';
  const acts = [];
  if (site) acts.push(`<button class="link" data-open="${esc(site)}">${esc(t('log_action_login', [nameOf(e.datasource)]))}</button>`);
  if (e.error) acts.push(`<button class="link" data-raw>${esc(t('log_action_details'))}</button>`);
  return `<li class="row err">${head}<span class="det">`
    + `<span class="msg">${esc(humanError(e))}${count}</span>`
    + (ep ? `<span class="ep">${esc(ep)}</span>` : '')
    + (acts.length ? `<span class="acts">${acts.join('')}</span>` : '')
    + (e.error ? `<code class="raw" hidden>${esc(e.error)}</code>` : '')
    + `</span></li>`;
}

async function render() {
  const el = $('#log');
  const entries = await getLog().catch(() => []);
  if (!entries.length) { el.innerHTML = `<div class="empty">${esc(t('no_activity'))}</div>`; return; }
  const days = new Map();
  for (const e of entries) { const k = dayKey(e.t); if (!days.has(k)) days.set(k, []); days.get(k).push(e); }
  let html = '';
  for (const [k, items] of days) {
    html += `<section class="day"><h2>${esc(dayLabel(k))}</h2><ul>`;
    for (const e of collapse(items)) html += rowHtml(e);
    html += '</ul></section>';
  }
  el.innerHTML = html;
  el.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => { try { chrome.tabs.create({ url: b.dataset.open }); } catch (x) {} });
  el.querySelectorAll('[data-raw]').forEach((b) => b.onclick = () => { const raw = b.closest('.det').querySelector('.raw'); if (raw) raw.hidden = !raw.hidden; });
}

async function init() {
  applyI18n();
  try { document.title = 'Habeas — ' + t('activity'); } catch (e) {}
  try { const L = chrome.i18n.getUILanguage() || 'en'; ESLANG = L.toLowerCase().startsWith('es'); } catch (e) {}
  { const o = $('#opts'); if (o) o.onclick = () => chrome.runtime.openOptionsPage(); }
  ADAPTERS = await getAdapters().catch(() => ({}));
  render();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch['habeas:log']) render(); });
}
init();
