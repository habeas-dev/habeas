// Record-mode plumbing for the author UI (extension-page side). Arms learn mode for a target
// site, dynamically grants it a content script (so we never ship <all_urls>), and reads back the
// samples + captured auth the in-session hook produced.
import { chrome } from './ext.js';
import { registrableDomain } from '../adapters/validate.js';

async function registerBridge(id, matches) {
  const spec = { id, matches, js: ['src/content/bridge.js'], runAt: 'document_start' };
  try {
    await chrome.scripting.registerContentScripts([spec]);
  } catch (e) {
    // Already registered from a previous run — update to be safe.
    try { await chrome.scripting.updateContentScripts([spec]); } catch (e2) {}
  }
}

// Ask for the whole registrable domain (login may live on any subdomain, e.g. account.*),
// register the content script there, arm learn mode, and open the site.
export async function startLearning(url) {
  const u = new URL(url);
  const domain = registrableDomain(u.hostname);
  const matches = [`${u.protocol}//*.${domain}/*`, `${u.protocol}//${domain}/*`];
  const granted = await chrome.permissions.request({ origins: matches });
  if (!granted) throw new Error('permission denied');
  await registerBridge('habeas-learn-' + domain.replace(/[^a-z0-9]/gi, ''), matches);
  const origin = u.origin + '/*';
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

// Diagnostic: how many requests the recorder observed, and from which hosts.
export async function getSeen(domain) {
  const o = await chrome.storage.session.get('seen:' + domain);
  return o['seen:' + domain] || { total: 0, hosts: {} };
}

// Document (PDF) request URLs observed during capture — used to infer the PDF endpoint.
export async function getAssets(domain) {
  const o = await chrome.storage.session.get('assets:' + domain);
  return o['assets:' + domain] || [];
}

// Rendered page texts captured during learn mode — used to classify public vs internal ids.
export async function getDomTexts(domain) {
  const o = await chrome.storage.session.get('dom:' + domain);
  return o['dom:' + domain] || [];
}

// Captured auth for a host, as { path -> headers } (plus a 'merged' fallback).
export async function getAuthFor(host) {
  const o = await chrome.storage.session.get('auth:' + host);
  const st = o['auth:' + host];
  if (!st) return null;
  return { byPath: st.byPath || {}, merged: st.merged || {} };
}
