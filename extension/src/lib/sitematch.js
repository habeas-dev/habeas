// "Does Habeas already have a source for this site?" — one rule, used by the background auto-run
// trigger and by the popup's offer to record a site nobody has taught it yet.
const hostOf = (a) => String((a && a.api && a.api.host) || '').replace(/^https?:\/\//, '');
const bareHost = (m) => String(m).replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '').replace(/^\*\./, '');
// endsWith('.' + h) rather than endsWith(h): otherwise `noesejemplo.test` would match `ejemplo.test`.
const covers = (h, host) => !!h && (host === h || host.endsWith('.' + h));

export function siteMatches(adapter, host) {
  if (!adapter || !host) return false;
  if (covers(adapter.domain, host)) return true;
  for (const m of adapter.match || []) if (covers(bareHost(m), host)) return true;
  return hostOf(adapter) === host;
}

// The first source covering `host`, or null. `all` is the id→adapter map from getAdapters().
export function knownSite(all, host) {
  if (!all || !host) return null;
  return Object.values(all).find((a) => siteMatches(a, host)) || null;
}
