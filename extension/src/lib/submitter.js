// The contributor identity used for handoffs. A PSEUDONYMOUS random id (never PII) generated once and
// kept in storage.local — it's the key to the contributor's own inbox (no account, no login). An optional
// `handle` is what gets credited when a source is authored from their recording. `seen` tracks the last
// message timestamp the contributor has read per handoff, so the UI can show an unread badge.
import { chrome } from './ext.js';

const KEY = 'habeas:submitter';

function randomId() {
  const a = new Uint8Array(16);
  (globalThis.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = (i * 2654435761) & 255; });
  return 'sub_' + [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getSubmitter() {
  const o = await chrome.storage.local.get(KEY);
  let s = o[KEY];
  if (!s || !s.id) { s = { id: randomId(), handle: '', seen: {} }; await chrome.storage.local.set({ [KEY]: s }); }
  if (!s.seen) s.seen = {};
  return s;
}

export async function setHandle(handle) {
  const s = await getSubmitter();
  s.handle = String(handle || '').trim().slice(0, 60);
  await chrome.storage.local.set({ [KEY]: s });
  return s;
}

// Mark a handoff's thread as read up to `at` (ISO string of the last message).
export async function markSeen(handoffId, at) {
  const s = await getSubmitter();
  s.seen[handoffId] = at || new Date(0).toISOString();
  await chrome.storage.local.set({ [KEY]: s });
  return s;
}

// How many of the contributor's handoffs have an unread team reply (for the badge/inbox count).
export function unreadCount(list, seen) {
  return (list || []).filter((h) => h.lastFrom === 'team' && h.lastAt && (!seen || !seen[h.id] || seen[h.id] < h.lastAt)).length;
}
