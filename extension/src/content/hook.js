// PAGE-context hook (injected by bridge.js). Captures the user's JWT + CSRF headers
// from the SPA's requests to the Carrefour API and forwards them via postMessage.
// Only the real user JWT (eyJ...) is forwarded — anonymous / Basic tokens are ignored.
(function () {
  const API = 'pro.api.carrefour.es';
  const KEYS = ['authorization', 'x-xsrf-token', 'x-csrf-token', 'requestorigin', 'sessionid'];
  function post(h) {
    const out = {};
    KEYS.forEach((k) => { if (h[k]) out[k] = h[k]; });
    if (out.authorization && /eyJ/.test(out.authorization)) {
      window.postMessage({ __habeas: true, type: 'auth', host: API, headers: out }, '*');
    }
  }
  function absorb(h) {
    if (!h) return;
    const o = {};
    try {
      if (h instanceof Headers) h.forEach((v, k) => (o[k.toLowerCase()] = v));
      else if (Array.isArray(h)) h.forEach(([k, v]) => (o[k.toLowerCase()] = v));
      else Object.keys(h).forEach((k) => (o[k.toLowerCase()] = h[k]));
    } catch (e) { return; }
    post(o);
  }
  const of = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (url && url.includes(API)) absorb((init && init.headers) || (input && input.headers));
    } catch (e) {}
    return of.apply(this, arguments);
  };
  const XP = XMLHttpRequest.prototype, oo = XP.open, os = XP.setRequestHeader;
  XP.open = function (m, u) { this.__u = u; this.__h = {}; return oo.apply(this, arguments); };
  XP.setRequestHeader = function (n, v) {
    try {
      if (this.__u && this.__u.includes(API)) {
        this.__h[n.toLowerCase()] = v;
        if (n.toLowerCase() === 'authorization') post(this.__h);
      }
    } catch (e) {}
    return os.apply(this, arguments);
  };
})();
