// PAGE-context hook (injected by bridge.js). Captures the user's JWT + CSRF/origin
// headers from the SPA's requests to the Carrefour API, TAGGED BY ENDPOINT PATH, and
// forwards them via postMessage. Only the real user JWT (eyJ...) is forwarded.
//
// Per-path matters: different endpoints send different `requestorigin` / CSRF values,
// and the API validates them — so to call an endpoint we must replay the headers the
// SPA used for THAT endpoint.
(function () {
  const API = 'pro.api.carrefour.es';
  const KEYS = ['authorization', 'x-xsrf-token', 'x-csrf-token', 'requestorigin', 'sessionid'];
  function post(url, h) {
    const out = {};
    KEYS.forEach((k) => { if (h[k]) out[k] = h[k]; });
    if (!(out.authorization && /eyJ/.test(out.authorization))) return;
    let path = '';
    try { path = new URL(url, location.href).pathname; } catch (e) {}
    window.postMessage({ __habeas: true, type: 'auth', host: API, path, headers: out }, '*');
  }
  function absorb(url, h) {
    if (!h) return;
    const o = {};
    try {
      if (h instanceof Headers) h.forEach((v, k) => (o[k.toLowerCase()] = v));
      else if (Array.isArray(h)) h.forEach(([k, v]) => (o[k.toLowerCase()] = v));
      else Object.keys(h).forEach((k) => (o[k.toLowerCase()] = h[k]));
    } catch (e) { return; }
    post(url, o);
  }
  const of = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (url && url.includes(API)) absorb(url, (init && init.headers) || (input && input.headers));
    } catch (e) {}
    return of.apply(this, arguments);
  };
  const XP = XMLHttpRequest.prototype, oo = XP.open, os = XP.setRequestHeader;
  XP.open = function (m, u) { this.__u = u; this.__h = {}; return oo.apply(this, arguments); };
  XP.setRequestHeader = function (n, v) {
    try {
      if (this.__u && this.__u.includes(API)) {
        this.__h[n.toLowerCase()] = v;
        post(this.__u, this.__h); // no-ops until the eyJ token is present, then completes
      }
    } catch (e) {}
    return os.apply(this, arguments);
  };
})();
