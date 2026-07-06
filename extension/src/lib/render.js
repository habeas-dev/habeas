// Render a client-side page and capture its FINAL DOM. Some documents (e.g. hover's receipt) only
// exist after the SPA renders + fetches its data in the user's session — a static fetch returns an
// empty shell. We open the URL in a BACKGROUND tab, wait for it to render, then grab the rendered
// `outerHTML` via executeScript. Cross-browser (Chrome + Firefox), no debugger permission.
import { chrome } from './ext.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function renderPage(url, opts = {}) {
  const waitMs = opts.waitMs || 3500;
  const timeout = opts.timeout || 20000;
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitComplete(tab.id, timeout);
    if (opts.waitFor) await waitSelector(tab.id, opts.waitFor, timeout);
    else await delay(waitMs);
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => '<!doctype html>\n' + document.documentElement.outerHTML });
    return (res && res.result) || '';
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
  }
}

function waitComplete(tabId, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; try { chrome.tabs.onUpdated.removeListener(l); } catch (e) {} resolve(); } };
    const l = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(l);
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === 'complete') finish(); }).catch(() => {});
    setTimeout(finish, timeout);
  });
}

async function waitSelector(tabId, sel, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: (s) => !!document.querySelector(s), args: [sel] });
      if (r && r.result) return;
    } catch (e) { /* tab still loading */ }
    await delay(400);
  }
}
