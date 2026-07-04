import { chrome } from '../lib/ext.js';
import { applyI18n, t } from '../lib/i18n.js';
import { fetchIndex, installFromEntry, getRatings } from '../registry/client.js';
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
  const hay = [e.id, e.name, e.service, e.domain, (e.categories || []).join(' ')].join(' ').toLowerCase();
  return hay.includes(q.toLowerCase());
}

function render() {
  const q = $('#q').value.trim();
  const list = ENTRIES.filter((e) => matches(e, q));
  if (!list.length) { $('#list').innerHTML = `<p class="muted">${t('market_empty')}</p>`; return; }
  $('#list').innerHTML = list.map((e) => {
    const installed = !!INSTALLED[e.id];
    const trust = e.trust === 'first-party' ? t('trust_first_party') : t('trust_community');
    const offsite = (e.crossDomain && e.crossDomain.length) ? `<span class="warn" title="${esc(e.crossDomain.join(', '))}">${t('market_offsite')}</span>` : '';
    return `<div class="card row" data-id="${esc(e.id)}">
      <div style="flex:1">
        <b>${esc(e.name || e.id)}</b> <code>${esc(e.id)}</code><br>
        <span class="muted">${esc((e.categories || []).join(', '))} · ${esc(e.domain || '')}</span>
        <span class="pill type">${trust}</span> ${offsite}
        <span class="rating muted" data-rate="${esc(e.id)}"></span>
      </div>
      <button data-install="${esc(e.id)}" ${installed ? 'disabled' : ''}>${installed ? t('market_installed') : t('market_install')}</button>
    </div>`;
  }).join('');
  $('#list').querySelectorAll('[data-install]').forEach((b) => b.onclick = () => onInstall(b.dataset.install));
  list.forEach(fillRating);
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
    btn.textContent = t('market_installed');
    $('#status').textContent = t('market_install_ok', [id]);
  } catch (e) {
    btn.disabled = false; btn.textContent = t('market_install');
    $('#status').textContent = t('market_install_err', [e.message]);
  }
}

init();
