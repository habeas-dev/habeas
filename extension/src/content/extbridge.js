// External-hooks bridge — runs on every https page (isolated world) so ANY site can talk to Habeas
// via window.postMessage. It relays page → background and back. It does NOT decide anything: the
// page's origin is taken authoritatively by the background from the sender (not from the message),
// and every action is origin-bound + consent-gated on the extension side.
(function () {
  const chrome = globalThis.browser ?? globalThis.chrome;
  const API = { 'propose-workflow': 1, collect: 1, status: 1 };
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.__habeasExt !== 'req' || !API[d.api] || typeof d.id !== 'string') return;
    try {
      chrome.runtime.sendMessage({ type: 'habeas:ext', api: d.api, payload: d.payload || {} }, (res) => {
        const response = chrome.runtime.lastError ? { ok: false, status: 'error', error: String(chrome.runtime.lastError.message || 'error') } : (res || { ok: false, status: 'error', error: 'no response' });
        window.postMessage({ __habeasExt: 'res', id: d.id, response }, location.origin);
      });
    } catch (e) {
      window.postMessage({ __habeasExt: 'res', id: d.id, response: { ok: false, status: 'error', error: String(e && e.message || e) } }, location.origin);
    }
  });
  // Let the page feature-detect that Habeas is present.
  try { window.postMessage({ __habeasExt: 'ready', version: 1 }, location.origin); } catch (e) {}
})();
