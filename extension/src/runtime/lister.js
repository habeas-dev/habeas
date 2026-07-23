// The shared "list a source's outputs into the canonical store" core. BOTH the popup's List (onList) and the
// Archive's Refresh call THIS SAME function, so they behave identically. It runs in the CALLING PAGE's context:
// the caller provides the captured `auth` and a page-context `net` (ensureSiteFetch) and, for grouped sources
// with no saved allow-list, a `pickGroup` callback (the account picker). It never touches the DOM itself.
import { listInventory } from './inventory.js';
import { withBrandHost } from '../lib/pagefetch.js';
import { resolveOutput, storeKeyOf, outputsOf } from '../lib/outputs.js';
import { putItems, getRecords } from '../lib/store.js';

// opts:
//   auth, net           — captured session + a page-context fetch
//   ds                  — the datasource (uses its saved account allow-list ds.groups, if any)
//   mode                — 'full' re-enumerates the whole history; else incremental (delta only)
//   outputs             — the outputs to list (default: every output of the source)
//   pickGroup(eff,auth,net) -> groupId  — transient account picker when there's no saved allow-list (optional)
//   signal              — AbortSignal
//   onStream(sid,eff,sk)                         — a stream is about to be listed (for the caller's diagnostics)
//   onProgress(sid,eff,sk,{year,page,docs})      — live per-page progress
//   onFresh(sid,eff,sk,freshDocs)                — the stream's freshly-listed docs (for the caller's display)
// Returns { listed, new }.
export async function listSourceInto(adapter, opts = {}) {
  const ds = opts.ds || {};
  const auth = opts.auth, net = opts.net;
  adapter = withBrandHost(adapter, net, ds); // brand (multi-TLD) source → api.host = the tab's domain, or the pinned country
  const outs = (opts.outputs && opts.outputs.length) ? opts.outputs : outputsOf(adapter);
  const streamIds = [...new Set(outs.map((o) => o.stream))];
  // A saved account filter (ds.groups) takes over: list ALL selected accounts, no per-list picker. Without
  // one, fall back to the transient "which account this time?" picker (pickGroup) — exactly like the classic.
  const filter = (ds.groups && ds.groups.length) ? ds.groups : null;
  let listed = 0, added = 0;
  for (const sid of streamIds) {
    if (opts.signal && opts.signal.aborted) break;
    const eff = resolveOutput(adapter, sid);
    const sk = storeKeyOf(adapter.id, sid);
    if (opts.onStream) opts.onStream(sid, eff, sk);
    const groupId = filter ? undefined : (opts.pickGroup ? await opts.pickGroup(eff, auth, net) : undefined);
    const known = (await getRecords(sk).catch(() => [])).map((r) => r.internalId).filter((x) => x != null);
    const knownSet = new Set(known.map(String));
    const fresh = await listInventory(eff, auth, net, {
      groupId, groups: filter, signal: opts.signal,
      knownIds: opts.mode === 'full' ? null : known, // incremental early-stop unless a full re-scan
      onProgress: opts.onProgress ? (p) => opts.onProgress(sid, eff, sk, p) : undefined,
    });
    if (opts.onFresh) opts.onFresh(sid, eff, sk, fresh);
    const items = fresh.filter((d) => d.internalId != null);
    // Synthetic docs are OPTIMISTIC (every month in the window) — many don't exist yet (before the account
    // opened). Don't persist them at list time (a successful download proves a month exists and stores it).
    const synthetic = eff.api && eff.api.list && eff.api.list.paging === 'synthetic';
    if (!synthetic && items.length) {
      try { await putItems(sk, items.map((d) => ({ internalId: d.internalId, record: d.record })), { source: adapter.id, schema: eff.schema, srcVersion: adapter.version }); } catch (e) { /* store best-effort */ }
    }
    listed += items.length;
    added += opts.mode === 'full' ? items.filter((d) => !knownSet.has(String(d.internalId))).length : items.length;
  }
  return { listed, new: added };
}
