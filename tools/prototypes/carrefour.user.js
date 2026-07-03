// ==UserScript==
// @name         Habeas prototype — Carrefour documents
// @namespace    https://habeas.dev
// @version      0.2.1
// @description  Prototype: list and download your own Carrefour purchase documents (tickets + online orders) within your logged-in session. Validates the Habeas client-side-in-session model. Not the shipped extension.
// @match        https://www.carrefour.es/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      pro.api.carrefour.es
// @license      AGPL-3.0-or-later
// ==/UserScript==
//
// v0.2.0 — runs in Tampermonkey's sandbox (CSP-safe) and reaches the page via
// unsafeWindow, so a strict Content-Security-Policy on carrefour.es can't stop it.
// API calls go through GM_xmlhttpRequest (bypasses CORS). Token is captured from
// the SPA's own requests (falls back to scanning storage for a JWT). Nothing is
// stored and nothing leaves the browser.
//
// Usage: install in Tampermonkey, open carrefour.es → "Mis compras" (so the SPA
// makes an authenticated call we can capture), then click "Habeas: Listar"
// (black button, bottom-right).

(function () {
  'use strict';
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const API_HOST = 'pro.api.carrefour.es';
  const LIST_URL = 'https://' + API_HOST + '/md-purchasesAccount-v1/purchases';
  const PDF_URL = id => 'https://' + API_HOST + '/md-ticketsAccount-v1/tickets/' + encodeURIComponent(id) + '/pdf';
  const COUNT = 50;

  // --- 1. Capture auth headers from the SPA's own requests to the API ---
  let captured = null;
  const isApi = u => typeof u === 'string' && u.indexOf(API_HOST) !== -1;
  const absorb = h => {
    if (!h) return;
    const out = {};
    try {
      if (h instanceof win.Headers || h instanceof Headers) h.forEach((v, k) => (out[k.toLowerCase()] = v));
      else if (Array.isArray(h)) h.forEach(([k, v]) => (out[k.toLowerCase()] = v));
      else Object.keys(h).forEach(k => (out[k.toLowerCase()] = h[k]));
    } catch (e) { return; }
    if (out.authorization) {
      captured = out;
      try { console.debug('[Habeas] captured API headers:', Object.keys(out).join(', '), '| token:', String(out.authorization).slice(0, 24) + '…'); } catch (e) {}
    }
  };
  try {
    const origFetch = win.fetch;
    win.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : input && input.url;
        if (isApi(url)) absorb((init && init.headers) || (input && input.headers));
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
    const XHR = win.XMLHttpRequest.prototype;
    const origOpen = XHR.open, origSet = XHR.setRequestHeader;
    XHR.open = function (m, u) { this.__hUrl = u; return origOpen.apply(this, arguments); };
    XHR.setRequestHeader = function (n, v) {
      try {
        if (isApi(this.__hUrl)) {
          (this.__hH = this.__hH || {})[n.toLowerCase()] = v;
          if (n.toLowerCase() === 'authorization') captured = this.__hH;
        }
      } catch (e) {}
      return origSet.apply(this, arguments);
    };
  } catch (e) { console.warn('[Habeas] could not hook network', e); }

  // Fallback: scan storage for a JWT if we never saw an in-flight token.
  function jwtFromStorage() {
    for (const store of [win.localStorage, win.sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const v = store.getItem(store.key(i));
          const m = v && v.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
          if (m) return { authorization: 'Bearer ' + m[0] };
        }
      } catch (e) {}
    }
    return null;
  }
  const getAuth = () => captured || jwtFromStorage();
  function authHeaders() {
    const c = getAuth(), h = {};
    if (c) Object.keys(c).forEach(k => {
      if (k === 'authorization' || /api-?key|subscription|token/.test(k)) h[k] = c[k];
    });
    return h;
  }

  // --- 2. Privileged HTTP (bypasses CORS + CSP) ---
  function gmGet(url, blob) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, headers: authHeaders(),
        responseType: blob ? 'blob' : undefined,
        onload: r => (r.status >= 200 && r.status < 300)
          ? resolve(blob ? r.response : JSON.parse(r.responseText))
          : reject(new Error('HTTP ' + r.status + ' — ' + String(r.responseText || '').replace(/\s+/g, ' ').slice(0, 300))),
        onerror: () => reject(new Error('network')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const eur = n => (typeof n === 'number' ? n.toFixed(2) + ' €' : '');
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // --- 3. Enumerate ALL documents, walking every offset stream ---
  async function inventory() {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 3 * 365 * 24 * 3600 * 1000).toISOString();
    let offs = { ticketOffset: 0, atgfOffset: 0, atgnfOffset: 0, currentTickets: 0, currentAtgfOrders: 0, currentAtgnfOrders: 0 };
    const seen = new Set(), all = [];
    for (let guard = 0; guard < 500; guard++) {
      const qs = new URLSearchParams(Object.assign({ from, to, count: COUNT }, offs));
      const data = await gmGet(LIST_URL + '?' + qs);
      const fresh = (data.purchases || []).filter(p => !seen.has(p.purchaseId));
      if (!fresh.length) break;
      fresh.forEach(p => { seen.add(p.purchaseId); all.push(p); });
      offs = Object.assign(offs, data.offsets || {});
      await sleep(200);
    }
    all.sort((a, b) => (a.purchaseDate < b.purchaseDate ? 1 : -1));
    return all;
  }

  async function downloadPdf(doc, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      const blob = await gmGet(PDF_URL(doc.purchaseId), true);
      download(blob, 'carrefour-' + doc.purchaseDate.slice(0, 10) + '-' + doc.purchaseId + '.pdf');
      if (btn) btn.textContent = '✓ PDF';
    } catch (e) {
      if (btn) { btn.textContent = 'PDF ✗'; btn.title = String(e.message); }
    } finally { if (btn) btn.disabled = false; }
  }

  // --- 4. UI ---
  function renderTable(docs) {
    const old = document.getElementById('habeas-panel'); if (old) old.remove();
    const p = document.createElement('div');
    p.id = 'habeas-panel';
    p.style.cssText = 'position:fixed;inset:5% 5% auto auto;max-height:80vh;width:min(760px,92vw);overflow:auto;z-index:2147483647;background:#fff;color:#111;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.35);font:13px system-ui,sans-serif';
    const rows = docs.map((d, i) => `<tr>
        <td>${i + 1}</td><td>${d.purchaseDate.slice(0, 10)}</td>
        <td>${d.purchaseTypeDetail ? d.purchaseTypeDetail.description : d.purchaseType || ''}</td>
        <td>${d.orderSourceDetail ? d.orderSourceDetail.description : d.orderSource || ''}</td>
        <td>${d.mallName || ''}</td>
        <td style="text-align:right">${eur(d.amount)}</td>
        <td><button data-id="${d.purchaseId}" class="habeas-dl">PDF</button></td></tr>`).join('');
    p.innerHTML = `
      <div style="position:sticky;top:0;background:#111;color:#fff;padding:10px 14px;display:flex;gap:8px;align-items:center">
        <b style="flex:1">Habeas · ${docs.length} documentos</b>
        <button id="habeas-all" style="cursor:pointer">Descargar todos los PDF</button>
        <button id="habeas-json" style="cursor:pointer">Exportar JSON</button>
        <button id="habeas-close" style="cursor:pointer">✕</button>
      </div>
      <table style="width:100%;border-collapse:collapse" cellpadding="6">
        <thead><tr style="text-align:left;background:#f2f2f2">
          <th>#</th><th>Fecha</th><th>Tipo</th><th>Origen</th><th>Tienda</th><th style="text-align:right">Importe</th><th></th>
        </tr></thead><tbody>${rows}</tbody></table>`;
    document.body.appendChild(p);
    p.querySelector('#habeas-close').onclick = () => p.remove();
    p.querySelectorAll('.habeas-dl').forEach(b => b.onclick = () => downloadPdf(docs.find(d => d.purchaseId === b.dataset.id), b));
    p.querySelector('#habeas-all').onclick = async () => {
      for (const b of p.querySelectorAll('.habeas-dl')) { await downloadPdf(docs.find(d => d.purchaseId === b.dataset.id), b); await sleep(400); }
    };
    p.querySelector('#habeas-json').onclick = () => {
      const manifest = docs.map(d => ({
        externalId: d.purchaseId, date: d.purchaseDate, total: d.amount, currency: 'EUR',
        store: { name: d.mallName, address: d.mallAddress, id: d.mallId },
        purchaseType: d.purchaseType, orderSource: d.orderSource,
      }));
      download(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), 'carrefour-inventory.json');
    };
  }

  function addButton() {
    if (document.getElementById('habeas-btn') || !document.body) return;
    const b = document.createElement('button');
    b.id = 'habeas-btn';
    b.textContent = 'Habeas: Listar';
    b.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;padding:10px 14px;background:#111;color:#fff;border:0;border-radius:8px;cursor:pointer;font:14px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    b.onclick = async () => {
      if (!getAuth()) { alert('Habeas: abre primero "Mis compras" para capturar tu sesión, y vuelve a pulsar Listar.'); return; }
      console.debug('[Habeas] auth source:', captured ? 'in-flight capture' : 'storage JWT (apikey may be missing!)', '| headers sent:', Object.keys(authHeaders()).join(', '));
      b.disabled = true; b.textContent = 'Habeas: listando…';
      try { renderTable(await inventory()); }
      catch (e) { alert('Habeas: error al listar (' + e.message + ')'); }
      finally { b.disabled = false; b.textContent = 'Habeas: Listar'; }
    };
    document.body.appendChild(b);
  }
  // Re-add if the SPA re-renders and drops it.
  setInterval(addButton, 1500);
  if (document.readyState !== 'loading') addButton();
  else document.addEventListener('DOMContentLoaded', addButton);
})();
