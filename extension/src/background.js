// Background service worker. Receives captured session auth (tagged by endpoint path)
// from the content bridge and stores it in storage.session (in-memory, cleared on
// browser close — the datasource token is a live secret and never touches disk).
//
// Stored shape per host: { merged: {...}, byPath: { '/path': {...} } }.
// byPath lets the runtime replay the exact headers the SPA used for a given endpoint
// (the API validates requestorigin / CSRF, which vary by endpoint); merged is fallback.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'habeas:auth' || !msg.host) return;
  const key = 'auth:' + msg.host;
  chrome.storage.session.get(key).then((o) => {
    const cur = o[key] || { merged: {}, byPath: {} };
    cur.merged = { ...cur.merged, ...msg.headers };
    if (msg.path) cur.byPath[msg.path] = { ...(cur.byPath[msg.path] || {}), ...msg.headers };
    chrome.storage.session.set({ [key]: cur });
  });
});
