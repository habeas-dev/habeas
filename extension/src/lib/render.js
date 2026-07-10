// Render a client-side page and capture its FINAL DOM. Some documents (e.g. hover's receipt) only
// exist after the SPA renders + fetches its data in the user's session — a static fetch returns an
// empty shell. We open the URL in a BACKGROUND tab, wait for it to render, then grab the rendered
// `outerHTML` via executeScript. Cross-browser (Chrome + Firefox), no debugger permission.
import { chrome } from './ext.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// An anti-bot API response (esp. DataDome) is a 403 whose body carries the interstitial CAPTCHA URL, e.g.
// {"url":"https://geo.captcha-delivery.com/interstitial/?..."}. Extract it so the user can be shown the
// CAPTCHA to solve (solving it sets the anti-bot cookie for the source domain → the next fetch passes).
// Returns the challenge URL, or null if this text isn't a recognizable anti-bot challenge.
export function challengeUrlOf(text) {
  const s = String(text || '');
  const j = s.match(/"url"\s*:\s*"([^"]+)"/); // DataDome JSON body
  if (j && /captcha-delivery|geo\.captcha|datadome|interstitial/i.test(j[1])) return j[1].replace(/\\\//g, '/');
  const u = s.match(/(https?:\/\/[^\s"'\\]*captcha-delivery[^\s"'\\]*)/i); // bare URL fallback
  return u ? u[1] : null;
}

// Is this tab showing an anti-bot interstitial (Cloudflare "Just a moment…", Turnstile, Akamai)
// rather than the real site? We must NOT collect there — the session isn't valid yet.
export async function isChallenged(tabId) {
  if (!tabId || !chrome.scripting) return false;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const t = (document.title || '').toLowerCase();
        if (/just a moment|checking your browser|attention required|un momento|verificando|verifying you are human/.test(t)) return true;
        if (document.querySelector('#challenge-running, #cf-challenge-running, #cf-please-wait, .cf-turnstile, [data-translate="checking_browser"]')) return true;
        return /cf-browser-verification|_cf_chl_opt|challenge-platform|__cf_chl|akam[ai]|captcha-delivery|datadome|geo\.captcha/.test((document.documentElement.outerHTML || '').slice(0, 6000));
      },
    });
    return !!(r && r.result);
  } catch (e) { return false; }
}

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
