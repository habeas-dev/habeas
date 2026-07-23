// Source INSTANCES — a brand (multi-TLD) source can be installed as several datasources, one per country/domain,
// each sharing the SAME adapter file but keeping its OWN canonical store, delivery ledger and schedule so their
// documents never mix. The canonical-store / ledger identity derives from the DATASOURCE id (not the adapter id):
// the first instance keeps the bare adapter id (an existing single-country install needs NO migration), and each
// extra country gets "adapter@domain". A non-brand source is always a single instance whose id equals the adapter.

// The store/ledger identity for a datasource: its own id, falling back to the adapter id for call sites that have
// no datasource in hand. (Existing sources have ds.id === adapter.id, so this is byte-compatible for them.)
export const storeIdOf = (ds, adapter) => (ds && ds.id) || (adapter && adapter.id) || '';

// The datasources that are instances of one adapter.
export const instancesOf = (datasources, adapterId) => (datasources || []).filter((d) => d.adapter === adapterId);

// The country/domain an instance is pinned to (single). Undefined → not pinned (interactive follows the tab).
export const brandDomainOf = (ds) => (ds && ds.brandDomain) || undefined;

// Reconcile the instances of a brand adapter to EXACTLY `domains` (the chosen countries), preserving each kept
// instance's id + config (so its store never moves) and dropping the datasources for un-chosen domains. The bare
// adapter id is the "primary slot": an existing bare instance keeps it if its domain stays chosen, otherwise the
// first newly-chosen domain that has no instance yet takes it; the rest become "adapter@domain". Zero domains →
// a single bare, un-pinned instance (the source follows whatever tab you're on). Returns a NEW datasources array.
export function reconcileInstances(datasources, adapter, domains) {
  const aid = adapter.id;
  const others = (datasources || []).filter((d) => d.adapter !== aid); // every OTHER source, untouched
  const mine = (datasources || []).filter((d) => d.adapter === aid);
  const chosen = [...new Set((domains || []).filter(Boolean))];
  const byDomain = new Map(mine.filter((d) => d.brandDomain).map((d) => [d.brandDomain, d]));
  const bare = mine.find((d) => d.id === aid);

  if (!chosen.length) {
    const base = bare || mine[0];
    if (!base) return datasources; // nothing installed → leave as-is
    const one = { ...base, id: aid }; delete one.brandDomain;
    return [...others, one];
  }
  // Decide which chosen domain owns the bare id: keep an existing bare instance on its domain if still chosen,
  // else the first newly-chosen domain that doesn't already have its own instance.
  let bareDomain = (bare && chosen.includes(bare.brandDomain)) ? bare.brandDomain : null;
  if (!bareDomain) bareDomain = chosen.find((dn) => !byDomain.has(dn)) || null;

  const out = [];
  for (const domain of chosen) {
    const id = domain === bareDomain ? aid : aid + '@' + domain;
    // Keep an existing instance's config (id, account allow-list, schedule opts) → its store never moves. When a
    // hitherto-unpinned bare datasource takes its first country, carry ITS config over too.
    const prev = byDomain.get(domain) || (id === aid ? bare : null);
    if (prev) { out.push({ ...prev, id, adapter: aid, brandDomain: domain }); continue; }
    out.push({ id, adapter: aid, brandDomain: domain, enabled: true, options: {} });
  }
  return [...others, ...out];
}

// One-time migration of the earlier "one datasource pinned to several countries (ds.brandDomains[])" shape to the
// instance model: each such datasource fans out into one instance per country. Mutates `cfg.datasources` in place;
// returns true if anything changed. `adaptersById` maps adapter id → adapter (to know it's really a brand source).
export function migrateBrandDomains(cfg, adaptersById) {
  let changed = false;
  for (const ds of [...(cfg.datasources || [])]) {
    if (!Array.isArray(ds.brandDomains)) continue;
    const doms = ds.brandDomains.filter(Boolean);
    delete ds.brandDomains;
    const adapter = adaptersById && adaptersById[ds.adapter];
    if (adapter && Array.isArray(adapter.domains) && doms.length) cfg.datasources = reconcileInstances(cfg.datasources, adapter, doms);
    changed = true;
  }
  return changed;
}
