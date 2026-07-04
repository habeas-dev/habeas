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

  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('src/content/hook.js');
  (document.head || document.documentElement).appendChild(s);
  s.remove();

  const arm = (on) => window.postMessage({ __habeas: true, type: 'arm', on: !!on }, '*');
  // Learn mode is armed per-domain via storage.session (set by the author UI).
  function syncLearn() {
    chrome.storage.session.get('habeas:learn').then((o) => {
      const l = o['habeas:learn'];
      arm(!!(l && l.active && l.domain === PAGE_DOMAIN));
    });
  }
  syncLearn();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'session' && ch['habeas:learn']) syncLearn(); });

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || !d.__habeas) return;
    if (d.type === 'auth') chrome.runtime.sendMessage({ type: 'habeas:auth', host: d.host, path: d.path, headers: d.headers });
    else if (d.type === 'sample') chrome.runtime.sendMessage({ type: 'habeas:sample', domain: PAGE_DOMAIN, sample: { url: d.url, method: d.method, status: d.status, reqHeaders: d.reqHeaders, json: d.json } });
  });
})();
