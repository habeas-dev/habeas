// ==UserScript==
// @name         Habeas prototype — Carrefour documents
// @namespace    https://habeas.dev
// @version      0.1.0
// @description  Prototype: list and download your own Carrefour purchase documents (tickets + online orders) within your logged-in session. Validates the Habeas client-side-in-session model. Not the shipped extension.
// @match        https://www.carrefour.es/*
// @run-at       document-start
// @grant        none
// @license      AGPL-3.0-or-later
// ==/UserScript==
//
// How it works:
//  - Carrefour's purchases API (pro.api.carrefour.es, a Google APIgee gateway) is
//    NOT behind Cloudflare; CORS is open and auth is a Bearer token only.
//  - This script captures the Bearer token the SPA already uses (by observing
//    outgoing requests) and reuses it to enumerate ALL available documents and
//    download their PDFs. No credentials are stored; nothing is sent anywhere —
//    everything stays local (downloads). This is the "inventory first" model.
//
// Usage: install in Tampermonkey, open carrefour.es → "Mis compras" (so the SPA
// makes an authenticated call we can capture), then click "Habeas: Listar".

(function () {
  'use strict';
  const API_HOST = 'pro.api.carrefour.es';
  const LIST_URL = 'https://' + API_HOST + '/md-purchasesAccount-v1/purchases';
  const PDF_URL = id => 'https://' + API_HOST + '/md-ticketsAccount-v1/tickets/' + encodeURIComponent(id) + '/pdf';
  const COUNT = 50;

  // --- 1. Capture the Bearer (and any api-key) headers the SPA sends to the API ---
  let captured = null;
  const isApi = u => typeof u === 'string' && u.indexOf(API_HOST) !== -1;
  const absorb = h => {
    if (!h) return;
    const out = {};
    if (h instanceof Headers) h.forEach((v, k) => (out[k.toLowerCase()] = v));
    else if (Array.isArray(h)) h.forEach(([k, v]) => (out[k.toLowerCase()] = v));
    else Object.keys(h).forEach(k => (out[k.toLowerCase()] = h[k]));
    if (out.authorization) captured = out;
  };
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (isApi(url)) absorb((init && init.headers) || (input && input.headers));
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) { this.__hUrl = u; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (n, v) {
    try {
      if (isApi(this.__hUrl)) {
        (this.__hH = this.__hH || {})[n.toLowerCase()] = v;
        if (n.toLowerCase() === 'authorization') captured = this.__hH;
      }
    } catch (e) {}
    return origSet.apply(this, arguments);
  };

  // Only replay auth-relevant headers (never forbidden ones like user-agent).
  const authHeaders = () => {
    const h = {};
    if (!captured) return h;
    Object.keys(captured).forEach(k => {
      if (k === 'authorization' || /api-?key|subscription|token/.test(k)) h[k] = captured[k];
    });
    return h;
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const eur = n => (typeof n === 'number' ? n.toFixed(2) + ' €' : '');
  const download = (blob, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  // --- 2. Enumerate ALL documents (tickets + online orders), walking every offset stream ---
  async function inventory() {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 3 * 365 * 24 * 3600 * 1000).toISOString(); // 3y back
    let offs = { ticketOffset: 0, atgfOffset: 0, atgnfOffset: 0, currentTickets: 0, currentAtgfOrders: 0, currentAtgnfOrders: 0 };
    const seen = new Set(), all = [];
    for (let guard = 0; guard < 500; guard++) {
      const qs = new URLSearchParams(Object.assign({ from, to, count: COUNT }, offs));
      const res = await fetch(LIST_URL + '?' + qs, { headers: authHeaders(), credentials: 'omit' });
      if (!res.ok) throw new Error('list ' + res.status);
      const data = await res.json();
      const fresh = (data.purchases || []).filter(p => !seen.has(p.purchaseId));
      if (!fresh.length) break;
      fresh.forEach(p => { seen.add(p.purchaseId); all.push(p); });
      offs = Object.assign(offs, data.offsets || {});
      await sleep(200); // be polite
    }
    all.sort((a, b) => (a.purchaseDate < b.purchaseDate ? 1 : -1));
    return all;
  }

  async function downloadPdf(doc, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      const res = await fetch(PDF_URL(doc.purchaseId), { headers: authHeaders(), credentials: 'omit' });
      if (!res.ok) throw new Error(res.status);
      download(await res.blob(), 'carrefour-' + doc.purchaseDate.slice(0, 10) + '-' + doc.purchaseId + '.pdf');
      if (btn) btn.textContent = '✓ PDF';
    } catch (e) {
      if (btn) { btn.textContent = 'PDF ✗'; btn.title = 'No disponible (' + e.message + ')'; }
    } finally { if (btn) btn.disabled = false; }
  }

  // --- 3. UI: inventory panel ---
  function renderTable(docs) {
    let p = document.getElementById('habeas-panel');
    if (p) p.remove();
    p = document.createElement('div');
    p.id = 'habeas-panel';
    p.style.cssText = 'position:fixed;inset:5% 5% auto auto;max-height:80vh;width:min(760px,92vw);overflow:auto;z-index:99999;background:#fff;color:#111;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.35);font:13px system-ui,sans-serif';
    const rows = docs.map((d, i) => `<tr>
        <td>${i + 1}</td>
        <td>${d.purchaseDate.slice(0, 10)}</td>
        <td>${d.purchaseTypeDetail ? d.purchaseTypeDetail.description : d.purchaseType || ''}</td>
        <td>${d.orderSourceDetail ? d.orderSourceDetail.description : d.orderSource || ''}</td>
        <td>${d.mallName || ''}</td>
        <td style="text-align:right">${eur(d.amount)}</td>
        <td><button data-id="${d.purchaseId}" class="habeas-dl">PDF</button></td>
      </tr>`).join('');
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
    p.querySelectorAll('.habeas-dl').forEach(b => {
      b.onclick = () => downloadPdf(docs.find(d => d.purchaseId === b.dataset.id), b);
    });
    p.querySelector('#habeas-all').onclick = async () => {
      for (const b of p.querySelectorAll('.habeas-dl')) { await downloadPdf(docs.find(d => d.purchaseId === b.dataset.id), b); await sleep(400); }
    };
    p.querySelector('#habeas-json').onclick = () => {
      const manifest = docs.map(d => ({
        externalId: d.purchaseId, date: d.purchaseDate, total: d.amount, currency: 'EUR',
        store: { name: d.mallName, address: d.mallAddress, id: d.mallId },
        purchaseType: d.purchaseType, orderSource: d.orderSource
      }));
      download(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), 'carrefour-inventory.json');
    };
  }

  function addButton() {
    if (document.getElementById('habeas-btn')) return;
    const b = document.createElement('button');
    b.id = 'habeas-btn';
    b.textContent = 'Habeas: Listar';
    b.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;padding:10px 14px;background:#111;color:#fff;border:0;border-radius:8px;cursor:pointer;font:14px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    b.onclick = async () => {
      if (!captured || !captured.authorization) {
        alert('Habeas: abre primero "Mis compras" para capturar tu sesión, y vuelve a pulsar Listar.');
        return;
      }
      b.disabled = true; b.textContent = 'Habeas: listando…';
      try { renderTable(await inventory()); }
      catch (e) { alert('Habeas: error al listar (' + e.message + ')'); }
      finally { b.disabled = false; b.textContent = 'Habeas: Listar'; }
    };
    document.body.appendChild(b);
  }
  if (document.readyState !== 'loading') addButton();
  else document.addEventListener('DOMContentLoaded', addButton);
})();
