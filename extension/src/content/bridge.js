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
    else if (d.type === 'sample') chrome.runtime.sendMessage({ type: 'habeas:sample', domain: PAGE_DOMAIN, sample: { url: d.url, method: d.method, status: d.status, reqHeaders: d.reqHeaders, json: d.json } });
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
