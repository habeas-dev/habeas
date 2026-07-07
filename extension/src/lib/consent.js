// Per-source consent. Built-in first-party same-domain sources need none. A community source —
// or ANY source with a cross-domain exception — must be explicitly consented to before it can
// read the user's session or replay it. Consent is keyed by a signature of the hosts the source
// touches, so if an updated source adds a new (esp. off-site) host, consent is invalidated and
// must be re-granted. This is the human gate that backs the code-enforced same-domain guard.
import { chrome } from './ext.js';
import { checkHosts } from '../adapters/validate.js';
import { isBuiltinSource } from '../adapters/loader.js';

const KEY = 'habeas:consent';

const stripHost = (m) => String(m).replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
// Only a BUILT-IN source can be trusted as first-party (project-audited). A user-imported source is
// always community for consent purposes — its self-declared `trust` in the JSON is ignored, so it can
// never skip the consent gate by claiming first-party.
const effectiveTrust = (adapter) => (isBuiltinSource(adapter.id) ? (adapter.trust || 'community') : 'community');

// What the consent screen shows, plus the signature we store on acceptance.
export function consentDescriptor(adapter) {
  const h = checkHosts(adapter);
  return {
    id: adapter.id,
    name: adapter.name || adapter.id,
    trust: effectiveTrust(adapter),
    categories: adapter.categories || [],
    matchHosts: (adapter.match || []).map(stripHost),
    apiHost: adapter.api && adapter.api.host ? stripHost(adapter.api.host) : '',
    domain: h.base,
    crossDomain: h.crossDomain,      // extra registrable domains → prominent off-site warning
    hosts: h.hosts,
    sig: h.hosts.slice().sort().join(',') + '|' + h.crossDomain.slice().sort().join(','),
  };
}

// First-party sources whose hosts all share one registrable domain are trusted implicitly.
export function needsConsent(adapter) {
  return effectiveTrust(adapter) === 'community' || (adapter.crossDomainHosts || []).length > 0;
}

export async function hasConsent(adapter) {
  if (!needsConsent(adapter)) return true;
  const o = await chrome.storage.local.get(KEY);
  return (o[KEY] || {})[adapter.id] === consentDescriptor(adapter).sig;
}

export async function grantConsent(adapter) {
  const o = await chrome.storage.local.get(KEY);
  const all = o[KEY] || {};
  all[adapter.id] = consentDescriptor(adapter).sig;
  await chrome.storage.local.set({ [KEY]: all });
}

export async function revokeConsent(id) {
  const o = await chrome.storage.local.get(KEY);
  const all = o[KEY] || {};
  delete all[id];
  await chrome.storage.local.set({ [KEY]: all });
}
