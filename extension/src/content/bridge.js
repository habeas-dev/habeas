// Isolated content script: injects the page hook, relays captured auth (tagged by endpoint
// path) to the background, and — when the user has armed record/learn mode for this domain —
// arms the hook and relays response SAMPLES for adapter drafting. Nothing is stored on disk.
(function () {
  const chrome = globalThis.browser ?? globalThis.chrome;
  const MULTI = new Set(['co.uk', 'org.uk', 'com.es', 'com.br', 'com.mx', 'com.ar', 'co.jp', 'com.au']);
  function regDomain(host) {
    const p = String(host || '').toLowerCase().split(':')[0].split('.').filter(Boolean);
    if (p.length <= 2) return p.join('.');
    const two = p.slice(-2).join('.');
    return MULTI.has(two) ? p.slice(-3).join('.') : two;
  }
  const PAGE_DOMAIN = regDomain(location.hostname);
  const arm = (on) => window.postMessage({ __habeas: true, type: 'arm', on: !!on }, '*');

  // Capture the RENDERED page text (what the user actually sees) — used to tell a public
  // receipt/invoice number (visible) from an internal id (only in URLs/traffic).
  function captureDom() {
    try {
      const text = ((document.body && document.body.innerText) || '').slice(0, 100000);
      if (text) chrome.runtime.sendMessage({ type: 'habeas:dom', domain: PAGE_DOMAIN, url: location.href, text });
    } catch (e) {}
    captureEmbeddedJson();
    captureMainHtml();
  }

  // Pure server-rendered (SSR) pages carry their data as HTML tables/rows in the document itself —
  // no XHR to sample. Capture the rendered document HTML (capped) so the inference can draft a
  // from:'html' source from it too. Only sent when the page actually contains repeated markup, and
  // never includes cookies (outerHTML doesn't expose document.cookie).
  function captureMainHtml() {
    try {
      const html = (document.documentElement && document.documentElement.outerHTML) || '';
      if (html && /<(table|tbody|tr|li|article|section)\b/i.test(html)) {
        chrome.runtime.sendMessage({ type: 'habeas:sample', domain: PAGE_DOMAIN, sample: { url: location.href, method: 'GET', status: 200, reqHeaders: {}, kind: 'html', html: html.length > 500000 ? html.slice(0, 500000) : html, fromHtml: true } });
      }
    } catch (e) {}
  }

  // SSR frameworks (Vike, Next, Nuxt, Inertia…) put the page's loaded data in a <script
  // type="application/json"> or a data-props attribute — the list may be there rather than in an XHR.
  // Post each parsed blob as a sample tagged fromHtml so the inference can offer a from:html list.
  function captureEmbeddedJson() {
    try {
      const objs = [];
      document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]').forEach((s) => { try { const o = JSON.parse(s.textContent); if (o && typeof o === 'object') objs.push(o); } catch (e) {} });
      document.querySelectorAll('[data-props],[data-page],[data-state]').forEach((el) => { for (const a of ['data-props', 'data-page', 'data-state']) { const v = el.getAttribute(a); if (v) { try { const o = JSON.parse(v); if (o && typeof o === 'object') objs.push(o); } catch (e) {} } } });
      for (const json of objs.slice(0, 6)) chrome.runtime.sendMessage({ type: 'habeas:sample', domain: PAGE_DOMAIN, sample: { url: location.href, method: 'GET', status: 200, reqHeaders: {}, json, fromHtml: true } });
    } catch (e) {}
  }

  // Learn mode is armed per-domain via storage.local (set by the author UI). Uses local, not
  // session, because content scripts can't read storage.session by default.
  let domScheduled = false;
  function syncLearn() {
    chrome.storage.local.get('habeas:learn').then((o) => {
      const l = o['habeas:learn'];
      const on = !!(l && l.active && l.domain === PAGE_DOMAIN);
      arm(on);
      if (on && !domScheduled) { domScheduled = true; setTimeout(captureDom, 1500); setTimeout(captureDom, 4000); }
    });
  }

  // Register listeners BEFORE injecting the hook so the hook's "ready" handshake is never missed.
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || !d.__habeas) return;
    if (d.type === 'hook-ready') syncLearn();               // (re)send arm state once the hook is live
    else if (d.type === 'auth') chrome.runtime.sendMessage({ type: 'habeas:auth', host: d.host, path: d.path, headers: d.headers });
    else if (d.type === 'sample') chrome.runtime.sendMessage({ type: 'habeas:sample', domain: PAGE_DOMAIN, sample: { url: d.url, method: d.method, status: d.status, reqHeaders: d.reqHeaders, json: d.json, kind: d.kind, html: d.html, reqBody: d.reqBody, fromHtml: d.fromHtml } });
    else if (d.type === 'asset') chrome.runtime.sendMessage({ type: 'habeas:asset', domain: PAGE_DOMAIN, asset: { url: d.url, method: d.method, reqType: d.reqType, reqBody: d.reqBody, referer: d.referer, status: d.status } });
    else if (d.type === 'seen') chrome.runtime.sendMessage({ type: 'habeas:seen', domain: PAGE_DOMAIN, host: d.host });
  });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch['habeas:learn']) syncLearn(); });

  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('src/content/hook.js');
  (document.head || document.documentElement).appendChild(s);
  s.remove();

  syncLearn(); // covers the case where the hook is already listening
})();
