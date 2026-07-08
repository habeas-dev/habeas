import { chrome } from '../lib/ext.js';
import { applyI18n, t } from '../lib/i18n.js';
import { fetchIndex, installFromEntry, getRatings, postRating, getComments, postComment } from '../registry/client.js';
import { getAdapters } from '../adapters/index.js';

const $ = (s) => document.querySelector(s);
// Registry entries come from the network → escape every interpolated value (a reviewed PR is
// the primary gate, but a hostile-but-valid entry must not be able to inject markup here).
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let ENTRIES = [];
let INSTALLED = {};

async function init() {
  applyI18n();
  $('#opts').onclick = () => chrome.runtime.openOptionsPage();
  $('#reload').onclick = load;
  $('#q').oninput = render;
  await load();
}

async function load() {
  $('#status').textContent = t('market_loading');
  INSTALLED = await getAdapters();
  try {
    ENTRIES = await fetchIndex();
    $('#status').textContent = t('market_count', [String(ENTRIES.length)]);
  } catch (e) {
    ENTRIES = [];
    $('#status').textContent = t('market_unavailable');
  }
  render();
}

function matches(e, q) {
  if (!q) return true;
  const hay = [e.id, e.name, e.service, e.domain, e.country, (e.categories || []).join(' '), (e.formats || []).join(' ')].join(' ').toLowerCase();
  return hay.includes(q.toLowerCase());
}
const flag = (code) => !code ? '' : code === 'global' ? '🌐' : (/^[A-Za-z]{2}$/.test(code) ? code.toUpperCase().replace(/./g, (c) => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)) : '');

// A catalog entry is newer than what's installed when its version string is greater (dates YYYY-MM-DD
// sort chronologically; a source with no stored version is treated as outdated so it gets a version).
function isOutdated(e) {
  const inst = INSTALLED[e.id];
  return !!inst && !!e.version && (!inst.version || String(e.version) > String(inst.version));
}

function render() {
  const q = $('#q').value.trim();
  const list = ENTRIES.filter((e) => matches(e, q));
  if (!list.length) { $('#list').innerHTML = `<p class="muted">${t('market_empty')}</p>`; return; }
  const outdated = list.filter(isOutdated);
  const banner = outdated.length
    ? `<div class="row" style="margin-bottom:10px;align-items:center;gap:8px"><span class="muted">${t('market_updates_available', [String(outdated.length)])}</span><button id="update-all" class="primary">${t('market_update_all')}</button></div>`
    : '';
  $('#list').innerHTML = banner + list.map((e) => {
    const inst = INSTALLED[e.id];
    const installed = !!inst;
    const up = isOutdated(e);
    const trust = e.trust === 'first-party' ? t('trust_first_party') : t('trust_community');
    const offsite = (e.crossDomain && e.crossDomain.length) ? `<span class="warn" title="${esc(e.crossDomain.join(', '))}">${t('market_offsite')}</span>` : '';
    const ver = e.version ? ` · v${esc(e.version)}` : '';
    const label = !installed ? t('market_install') : up ? t('market_update', [esc(inst.version || '?'), esc(e.version)]) : t('market_installed');
    return `<div class="card" data-id="${esc(e.id)}">
      <div class="row">
        <div style="flex:1">
          <b>${esc(e.name || e.id)}</b> <code>${esc(e.id)}</code><br>
          <span class="muted">${e.country ? flag(e.country) + ' ' : ''}${esc((e.categories || []).join(', '))} · ${esc(e.domain || '')}${(e.formats || []).length ? ' · ' + esc((e.formats || []).join('/').toUpperCase()) : ''}${ver}</span>
          <span class="pill type">${trust}</span> ${offsite}${up ? ` <span class="pill" style="border-color:#c77;color:#c77">${t('market_update_pill')}</span>` : ''}
          <span class="rating muted" data-rate="${esc(e.id)}"></span>
        </div>
        <button data-more="${esc(e.id)}">${t('market_details')}</button>
        <button data-install="${esc(e.id)}" ${installed && !up ? 'disabled' : ''}>${label}</button>
      </div>
      <div class="panel" data-panel="${esc(e.id)}" hidden style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px"></div>
    </div>`;
  }).join('');
  $('#list').querySelectorAll('[data-install]').forEach((b) => b.onclick = () => onInstall(b.dataset.install));
  $('#list').querySelectorAll('[data-more]').forEach((b) => b.onclick = () => toggleDetails(b.dataset.more));
  const ua = $('#update-all'); if (ua) ua.onclick = () => onUpdateAll(outdated.map((e) => e.id));
  list.forEach(fillRating);
}

const star = (on) => (on ? '★' : '☆');

async function toggleDetails(id) {
  const panel = document.querySelector(`[data-panel="${id}"]`);
  if (!panel) return;
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  await renderDetails(id, panel);
}

async function renderDetails(id, panel) {
  const [rating, comments] = await Promise.all([getRatings(id), getComments(id)]);
  const stars = [1, 2, 3, 4, 5].map((n) => `<button class="starbtn" data-star="${n}" title="${n}" style="background:none;border:none;cursor:pointer;font-size:18px;padding:0 1px;color:#e0a400">${star(rating && rating.avg >= n)}</button>`).join('');
  const clist = comments.length
    ? comments.map((c) => `<div style="margin:6px 0"><span class="muted">${esc(c.author || 'anon')} · ${esc((c.at || '').slice(0, 10))}</span><br>${esc(c.text || '')}</div>`).join('')
    : `<p class="muted">${t('market_no_comments')}</p>`;
  panel.innerHTML = `
    <div class="row"><span>${t('market_rate')}</span> <span data-stars>${stars}</span></div>
    <div class="section-title" style="margin-top:8px"><h3>${t('market_comments')}</h3></div>
    <div data-clist>${clist}</div>
    <div class="row" style="margin-top:8px">
      <input data-cauthor size="12" placeholder="${esc(t('market_author_ph'))}">
      <input data-ctext size="30" placeholder="${esc(t('market_comment_ph'))}">
      <button data-cpost>${t('market_post')}</button>
    </div>
    <span class="muted" data-dstatus></span>`;
  const setStatus = (m) => { const s = panel.querySelector('[data-dstatus]'); if (s) s.textContent = m; };
  panel.querySelectorAll('[data-star]').forEach((b) => b.onclick = async () => {
    try { await postRating(id, Number(b.dataset.star)); setStatus(t('market_rated')); await renderDetails(id, panel); fillRating({ id }); }
    catch (e) { setStatus(t('market_social_off')); }
  });
  panel.querySelector('[data-cpost]').onclick = async () => {
    const text = panel.querySelector('[data-ctext]').value.trim();
    const author = panel.querySelector('[data-cauthor]').value.trim();
    if (!text) return;
    try { await postComment(id, text, author || undefined); setStatus(t('market_posted')); await renderDetails(id, panel); }
    catch (e) { setStatus(t('market_social_off')); }
  };
}

async function fillRating(e) {
  const el = document.querySelector(`[data-rate="${e.id}"]`);
  if (!el) return;
  const r = await getRatings(e.id);
  if (r && r.count) el.textContent = ` · ★ ${Number(r.avg).toFixed(1)} (${r.count})`;
}

async function onInstall(id) {
  const entry = ENTRIES.find((e) => e.id === id);
  if (!entry) return;
  const btn = document.querySelector(`[data-install="${id}"]`);
  btn.disabled = true; btn.textContent = t('market_installing');
  try {
    await installFromEntry(entry);
    INSTALLED = await getAdapters();
    $('#status').textContent = t('market_install_ok', [id]);
    render(); // recompute installed / up-to-date state
  } catch (e) {
    btn.disabled = false; btn.textContent = t('market_install');
    $('#status').textContent = t('market_install_err', [e.message]);
  }
}

// Re-fetch + replace every outdated source in one go.
async function onUpdateAll(ids) {
  $('#status').textContent = t('market_updating', [String(ids.length)]);
  let ok = 0, fail = 0;
  for (const id of ids) {
    const entry = ENTRIES.find((e) => e.id === id);
    if (!entry) continue;
    try { await installFromEntry(entry); ok++; } catch (e) { fail++; }
  }
  INSTALLED = await getAdapters();
  $('#status').textContent = t('market_updated', [String(ok), String(fail)]);
  render();
}

init();
