// Background service worker. Receives captured session auth from the content bridge
// and MERGES it into storage.session (in-memory, cleared on browser close — the
// datasource token is a live secret and never touches disk).
//
// Why merge: different Carrefour endpoints send different subsets of headers (some
// include x-xsrf-token/x-csrf-token/sessionid, some don't). Merging accumulates the
// full set (CSRF + origin) while always taking the freshest token.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'habeas:auth' || !msg.host) return;
  const key = 'auth:' + msg.host;
  chrome.storage.session.get(key).then((o) => {
    chrome.storage.session.set({ [key]: { ...(o[key] || {}), ...msg.headers } });
  });
});
