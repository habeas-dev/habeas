// Habeas's OWN picker for the external `query` hook. A consumer site asked Habeas to search the user's
// documents; the candidates are shown HERE, in Habeas's window — they never reach the requesting page.
// The user ticks the ones to hand over, and only those are routed, server-to-server, to the consumer's
// origin-bound sink. This page is the "no channel out" boundary: nothing here is readable by the site.
import { chrome } from '../lib/ext.js';
import { applyI18n, t } from '../lib/i18n.js';

const $ = (s) => document.querySelector(s);
const reqId = new URLSearchParams(location.search).get('req');
const selected = new Set();
let cands = [];

function fmtAmount(amount, currency) {
  if (amount == null || amount === '') return '';
  const n = Number(amount);
  if (!isFinite(n)) return String(amount);
  try { return new Intl.NumberFormat(chrome.i18n.getUILanguage(), { style: 'currency', currency: currency || 'EUR' }).format(n); }
  catch (e) { return n.toFixed(2) + ' ' + (currency || ''); }
}

function refreshRouteBtn() {
  const n = selected.size;
  $('#route').disabled = n === 0;
  $('#route').textContent = n === 0 ? t('query_route') : t('query_route_n', [String(n)]);
  $('#count').textContent = t('query_found', [String(cands.length)]);
}

function render(dest) {
  $('#intro').textContent = t('query_intro', [dest]);
  const list = $('#list');
  list.textContent = '';
  if (!cands.length) { $('#empty').hidden = false; }
  cands.forEach((c, i) => {
    const row = document.createElement('label');
    row.className = 'cand';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => { if (cb.checked) selected.add(i); else selected.delete(i); refreshRouteBtn(); });
    const mid = document.createElement('div');
    const cp = document.createElement('div'); cp.className = 'cp'; cp.textContent = c.counterparty || c.sourceName || c.source || '—';
    const meta = document.createElement('div'); meta.className = 'meta muted';
    meta.textContent = [String(c.date || '').slice(0, 10), c.sourceName || c.source, c.number].filter(Boolean).join(' · ');
    mid.appendChild(cp); mid.appendChild(meta);
    const amt = document.createElement('div'); amt.className = 'amt'; amt.textContent = fmtAmount(c.amount, c.currency);
    row.appendChild(cb); row.appendChild(mid); row.appendChild(amt);
    list.appendChild(row);
  });
  refreshRouteBtn();
}

async function init() {
  applyI18n();
  if (!reqId) { $('#status').textContent = t('query_expired'); return; }
  let res;
  try { res = await chrome.runtime.sendMessage({ type: 'habeas:query-candidates', req: reqId }); }
  catch (e) { $('#status').textContent = t('query_expired'); return; }
  if (!res || !res.ok) { $('#status').textContent = t('query_expired'); return; }
  cands = Array.isArray(res.candidates) ? res.candidates : [];
  render(res.dest || '');

  $('#cancel').onclick = () => window.close();
  $('#route').onclick = async () => {
    if (!selected.size) return;
    $('#route').disabled = true; $('#cancel').disabled = true;
    $('#status').textContent = t('query_routing');
    const pick = [...selected].map((i) => ({ source: cands[i].source, stream: cands[i].stream, internalId: cands[i].internalId }));
    let r;
    try { r = await chrome.runtime.sendMessage({ type: 'habeas:query-route', req: reqId, pick }); }
    catch (e) { r = { ok: false }; }
    if (r && r.ok) {
      $('#status').textContent = t('query_done', [String(r.routed != null ? r.routed : pick.length)]);
      setTimeout(() => window.close(), 1200);
    } else {
      $('#status').className = 'warn'; $('#status').textContent = t('query_error');
      $('#cancel').disabled = false;
      refreshRouteBtn();
    }
  };
}

init();
