// A richer, ACCUMULATING failure diagnostic for "Report a problem". Instead of a single overwritten error,
// every failed request — a list/groups call, or a document/artifact fetch — appends a structured entry:
// which output (stream), which document, the request (method + URL) and its HTTP status, and the message.
// So a report shows EVERY failure and exactly WHICH request produced it, not just the first one hit.
// Capped and best-effort (a diagnostic must never break the flow it observes).
import { chrome } from './ext.js';

const KEY = (id) => 'habeas:diag:' + id;
const CAP = 30;

// Append one failure entry for a source. `entry` fields (all optional except message):
//   phase 'list'|'document', output (stream id), kind (artifact kind), item (doc date/id),
//   method, url, status (HTTP), message.
export async function pushDiag(sourceId, entry) {
  if (!sourceId || !entry) return;
  const k = KEY(sourceId);
  try {
    const o = await chrome.storage.local.get(k);
    const cur = o[k] && Array.isArray(o[k].entries) ? o[k] : { entries: [] };
    cur.entries.push({ at: new Date().toISOString(), ...entry });
    cur.entries = cur.entries.slice(-CAP); // keep the most recent CAP failures
    cur.at = new Date().toISOString();
    await chrome.storage.local.set({ [k]: cur });
  } catch (e) { /* best-effort */ }
}

export async function readDiag(sourceId) {
  try { const o = await chrome.storage.local.get(KEY(sourceId)); return o[KEY(sourceId)] || null; } catch (e) { return null; }
}
export async function clearDiag(sourceId) { try { await chrome.storage.local.remove(KEY(sourceId)); } catch (e) {} }

// Render a diagnostic to plain text for the team. Back-compatible with the old single-error shape
// ({ error, at }) so a report captured by an earlier build still reads. Returns '' when empty.
export function formatDiag(diag) {
  if (!diag) return '';
  if (diag.error && !Array.isArray(diag.entries)) return String(diag.error); // legacy shape
  const es = Array.isArray(diag.entries) ? diag.entries : [];
  if (!es.length) return '';
  return es.map((e) => {
    const where = [e.phase, e.output && ('output=' + e.output), e.kind && ('kind=' + e.kind), e.item != null && e.item !== '' && ('item=' + e.item)].filter(Boolean).join(' ');
    const status = e.status ? ' → HTTP ' + e.status : '';
    const req = e.url ? '\n    ' + ((e.method || 'GET') + ' ' + e.url) : '';
    return '• ' + (where ? where + ' — ' : '') + (e.message || '') + status + req;
  }).join('\n');
}

// Wrap a net(url, init) fetcher so the LAST request it issued (method, url, status) is remembered. A
// document fetch can be multi-step (generate → poll → download); on failure this tells the team which of
// those requests actually failed. Returns { net, ref } where ref.last = { method, url, status? }.
export function recordingNet(net) {
  const ref = { last: null };
  const fn = async (u, i) => {
    ref.last = { method: (i && i.method) || 'GET', url: String(u).split('#')[0] };
    const r = await net(u, i);
    if (r && typeof r.status === 'number') ref.last.status = r.status;
    return r;
  };
  return { net: fn, ref };
}
