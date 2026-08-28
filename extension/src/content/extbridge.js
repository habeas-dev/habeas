// External-hooks bridge — runs on every https page (isolated world) so ANY site can talk to Habeas
// via window.postMessage. It relays page → background and back. It does NOT decide anything: the
// page's origin is taken authoritatively by the background from the sender (not from the message),
// and every action is origin-bound + consent-gated on the extension side.
(function () {
  const chrome = globalThis.browser ?? globalThis.chrome;
  const API = { 'propose-workflow': 1, 'register-sink': 1, collect: 1, 'list-groups': 1, 'list-sources': 1, status: 1, 'revoke-grant': 1 };
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.__habeasExt !== 'req' || !API[d.api] || typeof d.id !== 'string') return;
    const reply = (response) => { try { window.postMessage({ __habeasExt: 'res', id: d.id, response }, location.origin); } catch (e) {} };
    const failed = (e) => ({ ok: false, status: 'error', error: String((e && e.message) || e || 'error') });
    try {
      // Ask WITHOUT a callback. Under MV3 sendMessage returns a promise in both browsers, and Firefox's
      // browser.* APIs are promise-ONLY: they read a second argument as `options`, so a Chrome-style
      // callback there is a type error — which this catch used to turn into "{ok:false}" for every site
      // integration on Firefox, while Chrome, which accepts the callback, was perfectly happy.
      const p = chrome.runtime.sendMessage({ type: 'habeas:ext', api: d.api, payload: d.payload || {} });
      if (p && typeof p.then === 'function') p.then((res) => reply(res || { ok: false, status: 'error', error: 'no response' }), (e) => reply(failed(e)));
      else reply({ ok: false, status: 'error', error: 'no response' }); // a runtime that answers neither way — say so rather than leave the page waiting
    } catch (e) { reply(failed(e)); }
  });
  // Let the page feature-detect that Habeas is present.
  try { window.postMessage({ __habeasExt: 'ready', version: 1 }, location.origin); } catch (e) {}
})();
