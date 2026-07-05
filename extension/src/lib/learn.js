// Record-mode plumbing for the author UI (extension-page side). Arms learn mode for a target
// site, dynamically grants it a content script (so we never ship <all_urls>), and reads back the
// samples + captured auth the in-session hook produced.
import { chrome } from './ext.js';
import { registrableDomain } from '../adapters/validate.js';

const scriptId = (origin) => 'habeas-learn-' + origin.replace(/[^a-z0-9]/gi, '');

async function registerBridge(origin) {
  const id = scriptId(origin);
  try {
    await chrome.scripting.registerContentScripts([{ id, matches: [origin], js: ['src/content/bridge.js'], runAt: 'document_start' }]);
  } catch (e) {
    // Already registered from a previous run — update to be safe.
    try { await chrome.scripting.updateContentScripts([{ id, matches: [origin], js: ['src/content/bridge.js'], runAt: 'document_start' }]); } catch (e2) {}
  }
}

// Ask for the origin, register the content script, arm learn mode, and open the site.
export async function startLearning(url) {
  const u = new URL(url);
  const origin = u.origin + '/*';
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error('permission denied');
  await registerBridge(origin);
  const domain = registrableDomain(u.hostname);
  // storage.local (not session): the content-script bridge must read this flag, and content
  // scripts cannot access storage.session by default (and Firefox lacks setAccessLevel).
  await chrome.storage.local.set({ 'habeas:learn': { active: true, domain, origin, url } });
  await chrome.tabs.create({ url });
  return { domain, origin };
}

export async function stopLearning() {
  await chrome.storage.local.set({ 'habeas:learn': { active: false } });
}

export async function getSamples(domain) {
  const o = await chrome.storage.session.get('samples:' + domain);
  return o['samples:' + domain] || [];
}

export async function clearSamples(domain) {
  await chrome.storage.session.remove('samples:' + domain);
}

// Captured auth for a host, as { path -> headers } (plus a 'merged' fallback).
export async function getAuthFor(host) {
  const o = await chrome.storage.session.get('auth:' + host);
  const st = o['auth:' + host];
  if (!st) return null;
  return { byPath: st.byPath || {}, merged: st.merged || {} };
}
