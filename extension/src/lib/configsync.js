// Device-portable config sync. A COPY of the user's setup — datasources (account/output/schedule settings),
// sinks (WITHOUT secrets — they carry only `secret://` refs; the values live in the encrypted, device-local store),
// and auto-sync routes — is written into the canonical STORE alongside the documents. A cloud-backed store
// (Drive/Dropbox/folder/…) then carries it to another machine, where it's merged in so "everything works as
// configured". Conflict policy: newest-wins per entry (by the snapshot's `savedAt`), union otherwise (a local-only
// source/sink/route is never dropped). Secrets are NEVER synced — a new device re-authenticates its destinations.
//
// THE METHOD — adopt a remote canonical ledger, never clobber it with a local copy. This is the invariant across
// the whole store layer: a device that connects to a shared/remote store READS it as the source of truth and only
// ever MERGES into it (union on write, newest-wins per id) — the local view can never SHRINK the shared state.
// It holds for the documents (store/sharded.js: append-merge; a full saveSource prunes only on an explicit
// {prune:true}; a partial read never resaves) AND here for the config snapshot (writeSnapshotIfChanged unions the
// remote in before writing). Deletions are therefore intentionally NOT propagated by sync — losing another
// device's data is never an accident; removing something is always an explicit, device-local action.
import { chrome } from './ext.js';
import { getConfig, saveConfig } from './config.js';
import { getConfigSnapshot, putConfigSnapshot } from './store.js';
import { getAdapters } from '../adapters/index.js';
import { fetchIndex, installFromEntry } from '../registry/client.js';
import { meetsMinVersion } from './version.js';
import { appendLog } from './state.js';

const APPLIED_KEY = 'habeas:config-synced'; // { at, sig } — the snapshot savedAt last applied + the config signature last written

// The portable subset. Nothing here is secret: sink credentials are `secret://id` refs (values are in the encrypted
// store), directory handles live in IndexedDB (not the config). So the snapshot is safe to place in a shared store.
export function buildSnapshot(cfg, at) {
  return { v: 1, savedAt: at, datasources: cfg.datasources || [], sinks: cfg.sinks || [], routes: cfg.routes || [] };
}
// A stable signature of the portable config — to tell a real user change from the echo of a just-applied snapshot.
export function configSig(cfg) {
  return JSON.stringify([cfg.datasources || [], cfg.sinks || [], cfg.routes || []]);
}
function mergeById(localArr, snapArr) {
  const out = [...(localArr || [])];
  const idx = new Map(out.map((x, i) => [String(x.id), i]));
  for (const s of snapArr || []) { const k = String(s.id); if (idx.has(k)) out[idx.get(k)] = { ...out[idx.get(k)], ...s }; else out.push(s); } // snap wins on conflict, local-only kept
  return out;
}
// Union that only ADDS: entries the snapshot has and we don't. Used when the snapshot is not newer than
// what we last applied — its shared entries may be stale, but an entry we simply lack cannot be.
function addMissingById(localArr, snapArr) {
  const out = [...(localArr || [])];
  const have = new Set(out.map((x) => String(x.id)));
  for (const s of snapArr || []) if (!have.has(String(s.id))) out.push(s);
  return out;
}
export function unionSnapshot(local, snap) {
  return { ...local, datasources: addMissingById(local.datasources, snap.datasources), sinks: addMissingById(local.sinks, snap.sinks), routes: addMissingById(local.routes, snap.routes) };
}

export function mergeSnapshot(local, snap) {
  return { ...local, datasources: mergeById(local.datasources, snap.datasources), sinks: mergeById(local.sinks, snap.sinks), routes: mergeById(local.routes, snap.routes) };
}

// Adapter ids a config references but this device doesn't have installed (built-ins are always present, so only
// community adapters surface here). Pure → testable. `installed` = the getAdapters() map (id → adapter).
export function missingAdapterIds(cfg, installed) {
  const have = installed || {};
  return [...new Set((cfg.datasources || []).map((d) => d && d.adapter).filter((a) => a && !have[a]))];
}
// Install from the community catalog any source a just-applied remote config uses but this machine lacks — so a
// config synced from another device brings its marketplace sources along (they otherwise reference a missing
// adapter and silently don't work). Only community catalog entries this build can run (minVersion) are installed.
export async function installMissingSources(cfg) {
  const needed = missingAdapterIds(cfg, await getAdapters().catch(() => ({})));
  if (!needed.length) return [];
  let catalog = []; try { catalog = await fetchIndex(); } catch (e) { return []; }
  const done = [];
  for (const id of needed) {
    const e = catalog.find((x) => x.id === id);
    if (!e || !meetsMinVersion(e.minVersion)) continue; // not in the catalog, or needs a newer extension
    try { await installFromEntry(e); done.push(id); } catch (err) { /* skip; the datasource just stays inactive */ }
  }
  if (done.length) { try { await appendLog({ kind: 'config-sync', status: 'ok', installed: done, count: done.length }); } catch (e) {} }
  return done;
}

async function syncState() { try { return (await chrome.storage.local.get(APPLIED_KEY))[APPLIED_KEY] || {}; } catch (e) { return {}; } }
async function setSyncState(patch) { try { await chrome.storage.local.set({ [APPLIED_KEY]: { ...(await syncState()), ...patch } }); } catch (e) {} }

// On open / startup: if the store's snapshot is NEWER than what this device last applied, merge it into the local
// config. Returns true if the local config changed. Best-effort — a store read failing just means no sync this time.
export async function applyStoredConfigIfNewer() {
  const snap = await getConfigSnapshot().catch(() => null);
  if (!snap || !snap.savedAt) return false;
  const st = await syncState();
  const local = await getConfig();
  // Not newer than what we last applied — but a union is idempotent, so "is it newer?" is the wrong
  // question for entries this device simply does not have. Adopt only those, never overwriting a shared
  // id with a possibly-stale value. This is also what heals a device whose own write pushed `at` past the
  // snapshot, which used to strand it from its peers permanently.
  if (snap.savedAt <= (st.at || 0)) {
    const grown = unionSnapshot(local, snap);
    if (configSig(grown) === configSig(local)) return false;
    await saveConfig(grown);
    await setSyncState({ sig: configSig(grown) }); // keep `at`: we did NOT adopt the snapshot wholesale
    installMissingSources(grown).catch(() => {});
    return true;
  }
  const merged = mergeSnapshot(local, snap);
  await saveConfig(merged);
  // Record what we applied AND its signature, so the saveConfig above (its own storage change) isn't mistaken for a
  // user edit and echoed straight back to the store (which would ping-pong savedAt between devices).
  await setSyncState({ at: snap.savedAt, sig: configSig(merged) });
  // Bring along any marketplace sources the synced config uses but this device doesn't have (best-effort, networked).
  installMissingSources(merged).catch(() => {});
  return true;
}
// Write the current config to the store IF it actually changed since the last write/apply (not the apply echo).
// ADOPT-then-write: never overwrite the shared snapshot with a bare local copy. A device that hasn't pulled the
// remote yet (applyStoredConfigIfNewer is fire-and-forget on startup) or that simply has fewer sinks/sources would
// otherwise SHRINK the shared snapshot for every device. So read the remote and UNION it under the local config
// (local wins per-id on a genuine edit), then write that superset. Trade-off: a removal doesn't propagate through
// the snapshot (the safe default the store already takes — never drop another device's config); a per-device
// removal stays local. `savedAt` still bumps so peers adopt the merged result.
export async function writeSnapshotIfChanged(cfg, nowMs) {
  const c = cfg || (await getConfig());
  const sig = configSig(c);
  const st = await syncState();
  if (sig === st.sig) return false; // unchanged (or equals what we just applied) → nothing to push
  const at = nowMs || Date.now();
  let toWrite = c;
  try {
    const remote = await getConfigSnapshot(); // adopt what's already there so a smaller local view can't clobber it
    if (remote && (remote.datasources || remote.sinks || remote.routes)) toWrite = mergeSnapshot(remote, c);
  } catch (e) { /* store unreadable → write the local copy (best-effort, same as before) */ }
  const ok = await putConfigSnapshot(buildSnapshot(toWrite, at));
  if (!ok) return false;
  // ADOPT LOCALLY TOO. Unioning the remote only into what we WRITE, then recording that savedAt as applied,
  // left this device permanently behind: applyStoredConfigIfNewer skips anything with savedAt <= at, so the
  // peer's sinks lived in the shared snapshot and never in this browser's own config. Saving the merged
  // config here is also what makes the sig below honest — it is the config this device now actually has.
  const mergedSig = configSig(toWrite);
  if (mergedSig !== sig) await saveConfig(toWrite);
  // sig of what this device ENDS UP with, so its own saveConfig isn't mistaken for a fresh user edit
  // (which would bump savedAt again and ping-pong), while a genuine later edit still differs from it.
  await setSyncState({ at, sig: mergedSig });
  return true;
}
