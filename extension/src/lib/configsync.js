// Device-portable config sync. A COPY of the user's setup — datasources (account/output/schedule settings),
// sinks (WITHOUT secrets — they carry only `secret://` refs; the values live in the encrypted, device-local store),
// and auto-sync routes — is written into the canonical STORE alongside the documents. A cloud-backed store
// (Drive/Dropbox/folder/…) then carries it to another machine, where it's merged in so "everything works as
// configured". Conflict policy: newest-wins per entry (by the snapshot's `savedAt`), union otherwise (a local-only
// source/sink/route is never dropped). Secrets are NEVER synced — a new device re-authenticates its destinations.
import { chrome } from './ext.js';
import { getConfig, saveConfig } from './config.js';
import { getConfigSnapshot, putConfigSnapshot } from './store.js';

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
export function mergeSnapshot(local, snap) {
  return { ...local, datasources: mergeById(local.datasources, snap.datasources), sinks: mergeById(local.sinks, snap.sinks), routes: mergeById(local.routes, snap.routes) };
}

async function syncState() { try { return (await chrome.storage.local.get(APPLIED_KEY))[APPLIED_KEY] || {}; } catch (e) { return {}; } }
async function setSyncState(patch) { try { await chrome.storage.local.set({ [APPLIED_KEY]: { ...(await syncState()), ...patch } }); } catch (e) {} }

// On open / startup: if the store's snapshot is NEWER than what this device last applied, merge it into the local
// config. Returns true if the local config changed. Best-effort — a store read failing just means no sync this time.
export async function applyStoredConfigIfNewer() {
  const snap = await getConfigSnapshot().catch(() => null);
  if (!snap || !snap.savedAt) return false;
  const st = await syncState();
  if (snap.savedAt <= (st.at || 0)) return false;
  const merged = mergeSnapshot(await getConfig(), snap);
  await saveConfig(merged);
  // Record what we applied AND its signature, so the saveConfig above (its own storage change) isn't mistaken for a
  // user edit and echoed straight back to the store (which would ping-pong savedAt between devices).
  await setSyncState({ at: snap.savedAt, sig: configSig(merged) });
  return true;
}
// Write the current config to the store IF it actually changed since the last write/apply (not the apply echo).
export async function writeSnapshotIfChanged(cfg, nowMs) {
  const c = cfg || (await getConfig());
  const sig = configSig(c);
  const st = await syncState();
  if (sig === st.sig) return false; // unchanged (or equals what we just applied) → nothing to push
  const at = nowMs || Date.now();
  const ok = await putConfigSnapshot(buildSnapshot(c, at));
  if (ok) await setSyncState({ at, sig });
  return ok;
}
