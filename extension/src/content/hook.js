// PAGE-context hook (injected by bridge.js). Two jobs, both scoped to the page's own
// registrable domain (eTLD+1) so it never touches unrelated third-party requests:
//   1. AUTH capture (always): grab the user's JWT + CSRF/origin headers the SPA sends to its
//      own API, tagged by host+path. Only a real user JWT (eyJ...) is forwarded.
//   2. LEARN mode (opt-in, armed by bridge.js): additionally capture request/response SAMPLES so
//      the record-mode author UI can auto-draft an adapter. Off by default.
(function () {
  const KEYS = ['authorization', 'x-xsrf-token', 'x-csrf-token', 'requestorigin', 'sessionid'];
  const HDR_SAMPLE = /^(authorization|x-.*token|x-.*csrf|x-xsrf-token|requestorigin|sessionid|content-type)$/i;
  const MULTI = new Set(['co.uk', 'org.uk', 'com.es', 'com.br', 'com.mx', 'com.ar', 'co.jp', 'com.au']);
  function regDomain(host) {
    const p = String(host || '').toLowerCase().split(':')[0].split('.').filter(Boolean);
    if (p.length <= 2) return p.join('.');
    const two = p.slice(-2).join('.');
    return MULTI.has(two) ? p.slice(-3).join('.') : two;
  }
  const PAGE_DOMAIN = regDomain(location.hostname);
  let LEARN = false;

  // Arm/disarm learn mode (bridge relays a chrome.storage signal into the page).
  window.addEventListener('message', (ev) => {
    if (ev.source === window && ev.data && ev.data.__habeas && ev.data.type === 'arm') LEARN = !!ev.data.on;
  });

  function hostOf(url) { try { return new URL(url, location.href).host; } catch (e) { return ''; } }
  function sameDomain(url) { const h = hostOf(url); return h && regDomain(h) === PAGE_DOMAIN; }
  function normalize(h) {
    const o = {};
    try {
      if (!h) return o;
      if (h instanceof Headers) h.forEach((v, k) => (o[k.toLowerCase()] = v));
      else if (Array.isArray(h)) h.forEach(([k, v]) => (o[k.toLowerCase()] = v));
      else Object.keys(h).forEach((k) => (o[k.toLowerCase()] = h[k]));
    } catch (e) {}
    return o;
  }
  function postAuth(url, h) {
    const out = {};
    KEYS.forEach((k) => { if (h[k]) out[k] = h[k]; });
    if (!(out.authorization && /eyJ/.test(out.authorization))) return;
    let path = ''; try { path = new URL(url, location.href).pathname; } catch (e) {}
    window.postMessage({ __habeas: true, type: 'auth', host: hostOf(url), path, headers: out }, '*');
  }
  function postSample(url, method, status, reqHeaders, bodyText) {
    if (!LEARN || !bodyText || bodyText.length > 400000) return;
    let json; try { json = JSON.parse(bodyText); } catch (e) { return; }
    if (!json || typeof json !== 'object') return;
    const rh = {}; Object.keys(reqHeaders || {}).forEach((k) => { if (HDR_SAMPLE.test(k)) rh[k] = reqHeaders[k]; });
    // Resolve to an absolute URL here (only the page knows location.href); SPAs fetch relative URLs.
    let abs = String(url), path = '';
    try { const u = new URL(url, location.href); abs = u.href; path = u.pathname; } catch (e) {}
    window.postMessage({ __habeas: true, type: 'sample', host: hostOf(url), path, url: abs, method: method || 'GET', status: status || 0, reqHeaders: rh, json }, '*');
  }
  // Lightweight "we saw a request" ping (host only) — powers the record-mode diagnostic.
  function postSeen(url) { if (LEARN) try { window.postMessage({ __habeas: true, type: 'seen', host: hostOf(url) }, '*'); } catch (e) {} }

  // Capture scope: normally only the page's own registrable domain (auth). In LEARN mode we also
  // capture from ANY host the page fetches — the service's API may be on another domain (the final
  // adapter then declares it via crossDomainHosts + off-site consent).
  const cap = (url) => sameDomain(url) || LEARN;

  const of = window.fetch;
  window.fetch = function (input, init) {
    let url, headers, method;
    try {
      url = typeof input === 'string' ? input : input && input.url;
      headers = normalize((init && init.headers) || (input && input.headers));
      method = (init && init.method) || (input && input.method) || 'GET';
      if (url && cap(url)) postAuth(url, headers);
      if (url) postSeen(url);
    } catch (e) {}
    const p = of.apply(this, arguments);
    if (url && LEARN) {
      try { p.then((res) => { try { res.clone().text().then((t) => postSample(url, method, res.status, headers, t)); } catch (e) {} }).catch(() => {}); } catch (e) {}
    }
    return p;
  };

  const XP = XMLHttpRequest.prototype, oo = XP.open, os = XP.setRequestHeader;
  XP.open = function (m, u) {
    this.__u = u; this.__m = m; this.__h = {};
    try {
      this.addEventListener('load', function () {
        try { postSeen(this.__u); if (LEARN) postSample(this.__u, this.__m, this.status, this.__h, this.responseText); } catch (e) {}
      });
    } catch (e) {}
    return oo.apply(this, arguments);
  };
  XP.setRequestHeader = function (n, v) {
    try {
      if (this.__u && cap(this.__u)) { this.__h[n.toLowerCase()] = v; postAuth(this.__u, this.__h); }
    } catch (e) {}
    return os.apply(this, arguments);
  };

  // Tell the isolated bridge we're live, so it (re)sends the current learn-mode arm state — the
  // hook loads as an async script and may miss the bridge's initial one-shot arm message.
  window.postMessage({ __habeas: true, type: 'hook-ready' }, '*');
})();
