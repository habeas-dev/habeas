// Isolated content script: injects the page hook and relays captured auth (tagged by
// endpoint path) to the background, which stores it in storage.session (never on disk).
(function () {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('src/content/hook.js');
  (document.head || document.documentElement).appendChild(s);
  s.remove();
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source === window && d && d.__habeas && d.type === 'auth') {
      chrome.runtime.sendMessage({ type: 'habeas:auth', host: d.host, path: d.path, headers: d.headers });
    }
  });
})();
