// PAGE-context hook (injected by bridge.js). Two jobs, both scoped to the page's own
// registrable domain (eTLD+1) so it never touches unrelated third-party requests:
//   1. AUTH capture (always): grab the user's JWT + CSRF/origin headers the SPA sends to its
//      own API, tagged by host+path. Only a real user JWT (eyJ...) is forwarded.
//   2. LEARN mode (opt-in, armed by bridge.js): additionally capture request/response SAMPLES so
//      the record-mode author UI can auto-draft an adapter. Off by default.
(function () {
  const KEYS = ['authorization', 'x-xsrf-token', 'x-csrf-token', 'requestorigin', 'sessionid'];
  // Capture the app-specific request headers (auth, csrf, and custom ones like dkt-ecom-*) so the
  // draft can replay them. Skip standard headers the browser sets itself (and can't be replayed).
  const HDR_SKIP = /^(accept|accept-language|accept-encoding|user-agent|referer|referrer|origin|cookie|content-length|host|connection|cache-control|pragma|priority|dnt|te|range|if-[a-z-]+|sec-[a-z-]+|upgrade-insecure-requests|traceparent|tracestate)$/i;
  const HDR_SAMPLE = { test: (k) => !HDR_SKIP.test(k) };
  const MULTI = new Set(['co.uk', 'org.uk', 'com.es', 'com.br', 'com.mx', 'com.ar', 'co.jp', 'com.au']);
  function regDomain(host) {
    const p = String(host || '').toLowerCase().split(':')[0].split('.').filter(Boolean);
    if (p.length <= 2) return p.join('.');
    const two = p.slice(-2).join('.');
    return MULTI.has(two) ? p.slice(-3).join('.') : two;
  }
  const PAGE_DOMAIN = regDomain(location.hostname);
  let LEARN = false;
  // Per-source capture config for THIS page, supplied by bridge.js from the enabled sources:
  //   hosts: extra (cross-domain) API hosts whose auth/context we may capture (a source's
  //          crossDomainHosts). context: [{name, from:'url', match}] values to capture from a request
  //          URL (e.g. a DNI). tokenMatch: regex the Authorization must match for those hosts (a
  //          non-JWT opaque bearer token won't match the default 'eyJ').
  let CAP = { hosts: [], context: [], tokenMatch: '' };

  // Arm/disarm learn mode + receive the capture config (bridge relays chrome.storage signals in).
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || !ev.data.__habeas) return;
    if (ev.data.type === 'arm') LEARN = !!ev.data.on;
    else if (ev.data.type === 'config') CAP = { hosts: ev.data.hosts || [], context: ev.data.context || [], tokenMatch: ev.data.tokenMatch || '' };
  });

  function hostOf(url) { try { return new URL(url, location.href).host; } catch (e) { return ''; } }
  function sameDomain(url) { const h = hostOf(url); return h && regDomain(h) === PAGE_DOMAIN; }
  // Is this request host one of the source's declared (cross-domain) API hosts?
  function hostAllowed(url) { const h = hostOf(url); if (!h) return false; return CAP.hosts.some((x) => h === x || regDomain(h) === regDomain(x)); }
  // Whether an Authorization value is a real user token worth keeping. Default is a JWT (eyJ…); a source
  // with an opaque bearer token declares auth.tokenMatch, applied only to its own declared API hosts.
  function tokenOk(url, authz) {
    if (!authz) return false;
    const tm = (hostAllowed(url) && CAP.tokenMatch) ? CAP.tokenMatch : 'eyJ';
    try { return new RegExp(tm).test(authz); } catch (e) { return authz.indexOf(tm) >= 0; }
  }
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
    // Outside learn mode only keep a real user token (JWT by default, or a source-declared pattern for
    // its own hosts). During authoring we also capture the headers that ride alongside COOKIE auth.
    if (!LEARN && !tokenOk(url, out.authorization)) return;
    if (!Object.keys(out).length) return;
    let path = ''; try { path = new URL(url, location.href).pathname; } catch (e) {}
    window.postMessage({ __habeas: true, type: 'auth', host: hostOf(url), path, headers: out }, '*');
  }
  // Capture a declared CONTEXT value from a request URL (e.g. a DNI in /posicionGlobal/es/{DNI}) and
  // relay it like auth. Gated by CAP.context (only populated for enabled cross-domain sources).
  function postContext(url) {
    if (!CAP.context.length) return;
    let abs = String(url); try { abs = new URL(url, location.href).href; } catch (e) {}
    for (const c of CAP.context) {
      if (c.from && c.from !== 'url') continue;
      let m; try { m = new RegExp(c.match).exec(abs); } catch (e) { continue; }
      if (m && m[1]) window.postMessage({ __habeas: true, type: 'context', host: hostOf(url), name: c.name, value: m[1] }, '*');
    }
  }
  // A response sample. JSON responses power the classic SPA-API inference; HTML responses (an AJAX
  // endpoint that returns a table fragment) are kept too — tagged `kind:'html'` — so the inference
  // can draft a `from:'html'` source. The request body is carried (capped) to reconstruct paging
  // (e.g. a POST `pagina=1`). Cookies/secrets are never sent (only allow-listed request headers).
  function postSample(url, method, status, reqHeaders, bodyText, contentType, reqBody) {
    if (!LEARN || !bodyText || bodyText.length > 600000) return;
    const rh = {}; Object.keys(reqHeaders || {}).forEach((k) => { if (HDR_SAMPLE.test(k)) rh[k] = reqHeaders[k]; });
    let abs = String(url), path = '';
    try { const u = new URL(url, location.href); abs = u.href; path = u.pathname; } catch (e) {}
    const body = typeof reqBody === 'string' ? reqBody.slice(0, 20000) : '';
    let json; try { json = JSON.parse(bodyText); } catch (e) {}
    if (json && typeof json === 'object') {
      window.postMessage({ __habeas: true, type: 'sample', host: hostOf(url), path, url: abs, method: method || 'GET', status: status || 0, reqHeaders: rh, json, reqBody: body }, '*');
      return;
    }
    // Not JSON — keep it only if it's HTML (content-type says so, or it opens with an HTML tag).
    const looksHtml = /html|xml/i.test(contentType || '') || /^\s*<(!doctype|html|table|div|tr|tbody|ul|ol|section|body|main)\b/i.test(bodyText);
    if (!looksHtml) return;
    const html = bodyText.length > 500000 ? bodyText.slice(0, 500000) : bodyText;
    window.postMessage({ __habeas: true, type: 'sample', host: hostOf(url), path, url: abs, method: method || 'GET', status: status || 0, reqHeaders: rh, kind: 'html', html, reqBody: body, fromHtml: true }, '*');
  }
  // Lightweight "we saw a request" ping (host only) — powers the record-mode diagnostic.
  function postSeen(url) { if (LEARN) try { window.postMessage({ __habeas: true, type: 'seen', host: hostOf(url) }, '*'); } catch (e) {} }
  // A document asset (PDF/binary). We record the REQUEST (method, url, content-type, body) — never
  // the response bytes — so we can infer the PDF path AND replay POST-generated PDFs (some services,
  // e.g. Decathlon, generate the PDF from posted invoice data rather than a simple GET).
  const isPdfLike = (ct, url) => /pdf|octet-stream/.test(ct || '') || /\.pdf(\?|$)/i.test(String(url || ''));
  function postAsset(url, opts) {
    if (!LEARN) return;
    let abs = String(url); try { abs = new URL(url, location.href).href; } catch (e) {}
    const body = typeof (opts && opts.reqBody) === 'string' ? opts.reqBody.slice(0, 20000) : '';
    // location.href = the page the PDF was requested from — the Referer many services require.
    window.postMessage({ __habeas: true, type: 'asset', host: hostOf(url), url: abs, method: (opts && opts.method) || 'GET', reqType: String((opts && opts.reqType) || ''), reqBody: body, referer: location.href, status: (opts && opts.status) || 0 }, '*');
  }

  // A PDF/receipt downloaded by clicking a link is a browser navigation, NOT a fetch/XHR — the hooks
  // below never see it. Capture such clicks (learn mode) so the PDF path can still be inferred.
  document.addEventListener('click', (ev) => {
    if (!LEARN) return;
    const a = ev.target && ev.target.closest && ev.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (isPdfLike('', a.href || href) || a.hasAttribute('download') || /(receipt|invoice|factura|ticket|download|\.pdf)/i.test(href)) {
      postAsset(a.href || href, { method: 'GET' });
    }
  }, true);

  // Capture scope: normally only the page's own registrable domain (auth). In LEARN mode we also
  // capture from ANY host the page fetches — the service's API may be on another domain (the final
  // adapter then declares it via crossDomainHosts + off-site consent).
  const cap = (url) => sameDomain(url) || LEARN || hostAllowed(url);

  // mtop (Alibaba's gateway — Taobao/Tmall/AliExpress/Lazada/1688…): stash the page's OWN request body per
  // api on a page global, so Habeas's same-world (MAIN) executor can reuse the live, correctly-built payload
  // (no hardcoded blob) + let the page re-sign for pagination. Cheap: only POSTs to /h5/mtop.<api>/.
  function stashMtop(url, method, body) {
    try {
      if (String(method || 'GET').toUpperCase() !== 'POST' || typeof body !== 'string' || !body) return;
      const m = String(url).match(/\/h5\/(mtop\.[^/]+)\//i);
      if (m) (window.__habeas_mtop = window.__habeas_mtop || {})[m[1].toLowerCase()] = body;
    } catch (e) {}
  }

  const of = window.fetch;
  window.fetch = function (input, init) {
    let url, headers, method;
    try {
      url = typeof input === 'string' ? input : input && input.url;
      headers = normalize((init && init.headers) || (input && input.headers));
      method = (init && init.method) || (input && input.method) || 'GET';
      if (url && cap(url)) { postAuth(url, headers); postContext(url); }
      if (url) postSeen(url);
      stashMtop(url, method, init && init.body);
    } catch (e) {}
    const p = of.apply(this, arguments);
    if (url && LEARN) {
      try {
        p.then((res) => {
          try {
            const ct = (res.headers.get('content-type') || '').toLowerCase();
            const rb = (init && typeof init.body === 'string') ? init.body : '';
            if (isPdfLike(ct, url)) postAsset(url, { method, reqType: headers && headers['content-type'], reqBody: rb, status: res.status });
            else res.clone().text().then((t) => postSample(url, method, res.status, headers, t, ct, rb));
          } catch (e) {}
        }).catch(() => {});
      } catch (e) {}
    }
    return p;
  };

  const XP = XMLHttpRequest.prototype, oo = XP.open, os = XP.setRequestHeader, osend = XP.send;
  XP.open = function (m, u) {
    this.__u = u; this.__m = m; this.__h = {}; this.__body = '';
    try {
      this.addEventListener('load', function () {
        try {
          postSeen(this.__u);
          if (!LEARN) return;
          const ct = ((this.getResponseHeader && this.getResponseHeader('content-type')) || '').toLowerCase();
          if (isPdfLike(ct, this.__u)) postAsset(this.__u, { method: this.__m, reqType: this.__h['content-type'], reqBody: this.__body, status: this.status });
          else postSample(this.__u, this.__m, this.status, this.__h, this.responseText, ct, this.__body);
        } catch (e) {}
      });
    } catch (e) {}
    return oo.apply(this, arguments);
  };
  XP.setRequestHeader = function (n, v) {
    try {
      if (this.__u && cap(this.__u)) { this.__h[n.toLowerCase()] = v; postAuth(this.__u, this.__h); postContext(this.__u); }
    } catch (e) {}
    return os.apply(this, arguments);
  };
  XP.send = function (b) { try { if (typeof b === 'string') this.__body = b; stashMtop(this.__u, this.__m, b); } catch (e) {} return osend.apply(this, arguments); };

  // Tell the isolated bridge we're live, so it (re)sends the current learn-mode arm state — the
  // hook loads as an async script and may miss the bridge's initial one-shot arm message.
  window.postMessage({ __habeas: true, type: 'hook-ready' }, '*');
})();
