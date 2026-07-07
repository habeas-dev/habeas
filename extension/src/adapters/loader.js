// Adapter loader — the single source of truth for the sources Habeas knows about.
// Merges bundled first-party adapters with user/community adapters stored as DATA in
// storage.local (`habeas:sources`). Every stored adapter is validated before it is trusted;
// invalid ones are skipped so a bad import can never take down the catalog.
import { chrome } from '../lib/ext.js';
import { validateAdapter } from './validate.js';
import carrefour from './carrefour-es.js';

// Bundled, project-maintained sources (working, API-verified). Only real, verified sources ship
// here; everything else is user/community DATA loaded from storage at runtime.
export const BUILTIN = [carrefour];

// A source is "built-in" (shipped, non-editable) only if it's bundled here. Everything the user
// imports/records lives in storage.local and is always editable/removable — regardless of its
// declared `trust` (which is just an audited-vs-community LABEL, not an ownership/lock signal).
const BUILTIN_IDS = new Set(BUILTIN.map((a) => a.id));
export const isBuiltinSource = (id) => BUILTIN_IDS.has(id);

const STORE_KEY = 'habeas:sources';

export async function getStoredSources() {
  const o = await chrome.storage.local.get(STORE_KEY);
  return o[STORE_KEY] || [];
}

async function setStoredSources(arr) {
  await chrome.storage.local.set({ [STORE_KEY]: arr });
}

// Add or replace a community/local source (validated). Throws on invalid input.
export async function saveSource(adapter) {
  const v = validateAdapter(adapter);
  if (!v.ok) throw new Error('invalid source: ' + v.errors.join('; '));
  const arr = await getStoredSources();
  const i = arr.findIndex((a) => a.id === adapter.id);
  const stored = { ...adapter, trust: adapter.trust || 'community' };
  if (i >= 0) arr[i] = stored; else arr.push(stored);
  await setStoredSources(arr);
  return stored;
}

export async function removeSource(id) {
  await setStoredSources((await getStoredSources()).filter((a) => a.id !== id));
}

// The live catalog: built-ins plus every VALID stored community source (keyed by id).
export async function getAdapters() {
  const map = {};
  for (const a of BUILTIN) map[a.id] = a;
  for (const a of await getStoredSources()) {
    if (validateAdapter(a).ok) map[a.id] = a;
  }
  return map;
}

export function getBuiltinAdapters() {
  const map = {};
  for (const a of BUILTIN) map[a.id] = a;
  return map;
}
