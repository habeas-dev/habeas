// Registering the in-session capture bridge for a source. The static content_scripts in the manifest
// only cover a built-in site; every OTHER enabled source needs bridge.js injected (document_start) on
// its login site so the page hook can capture the bearer token + context values (e.g. a DNI) as the
// user logs in. Cookie sources don't need a token, but running the bridge there is harmless.
import { chrome } from './ext.js';

const asOrigin = (h) => 'https://' + String(h).replace(/^https?:\/\//, '').replace(/[/:*].*$/, '') + '/*';

// Host permissions a source needs: its login site(s) (match), its API host, and any cross-domain hosts —
// so the capture script runs on the login site AND the page-context fetch can reach the API.
export function originsFor(adapter) {
  const out = new Set();
  for (const m of adapter.match || []) out.add(m);
  if (adapter.api && adapter.api.host) out.add(asOrigin(adapter.api.host));
  for (const h of adapter.crossDomainHosts || []) out.add(asOrigin(h));
  return [...out];
}

// Request the host permissions (must run in a user gesture — e.g. the Enable click). Returns granted?.
export async function requestCapturePermissions(adapter) {
  try { return await chrome.permissions.request({ origins: originsFor(adapter) }); } catch (e) { return false; }
}

// Register (or update) the capture scripts on the source's login site(s): the hook runs in the page's
// MAIN world (so a strict page CSP can't block it — banks often refuse a chrome-extension: <script>),
// and bridge runs in the ISOLATED world (for chrome.runtime/storage). They talk via window.postMessage.
// Idempotent; needs the host permission already granted for the match patterns.
export async function registerCapture(adapter) {
  const matches = (adapter.match || []).filter(Boolean);
  if (!matches.length || !(chrome.scripting && chrome.scripting.registerContentScripts)) return;
  const specs = [
    { id: 'caph-' + adapter.id, matches, js: ['src/content/hook.js'], runAt: 'document_start', world: 'MAIN' },
    { id: 'cap-' + adapter.id, matches, js: ['src/content/bridge.js'], runAt: 'document_start' },
  ];
  for (const spec of specs) {
    try { await chrome.scripting.registerContentScripts([spec]); }
    catch (e) { try { await chrome.scripting.updateContentScripts([spec]); } catch (e2) {} }
  }
}

export async function unregisterCapture(id) {
  try { await chrome.scripting.unregisterContentScripts({ ids: ['cap-' + id, 'caph-' + id] }); } catch (e) {}
}
