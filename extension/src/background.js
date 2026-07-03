// Background service worker. Minimal for now: receives captured session auth from
// the content bridge and stores it in storage.session (in-memory, cleared on browser
// close) so it is NEVER written to disk — the datasource token is a live secret.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'habeas:auth' && msg.host) {
    chrome.storage.session.set({ ['auth:' + msg.host]: msg.headers });
  }
});
