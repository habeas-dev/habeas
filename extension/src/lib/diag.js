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
    const ts = e.at ? '[' + String(e.at).slice(0, 19).replace('T', ' ') + '] ' : ''; // YYYY-MM-DD HH:MM:SS
    const where = [e.phase, e.output && ('output=' + e.output), e.kind && ('kind=' + e.kind), e.item != null && e.item !== '' && ('item=' + e.item)].filter(Boolean).join(' ');
    const status = e.status ? ' → HTTP ' + e.status : '';
    const req = e.url ? '\n    ' + ((e.method || 'GET') + ' ' + e.url) : '';
    return '• ' + ts + (where ? where + ' — ' : '') + (e.message || '') + status + req;
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

// ---- request-context ring ---------------------------------------------------------------------------
// The webRequest observer sees the FULL headers a request carried — including the browser-set Origin,
// Referer and Cookie that the in-page sample hook drops. It fires on BOTH the site's own SPA request AND
// our replay fetch (same URL). Recording a REDACTED context per request (header NAMES only, host-level
// origin/referer, cookie presence, and the response status) lets the team diff a WORKING request against a
// FAILING one — e.g. "the SPA's /accounts carried a cookie + these headers; our 401'd one didn't." Never
// stores header VALUES, cookies, tokens, or query strings. storage.local (non-sensitive), capped, best-effort.
const RCKEY = (id) => 'habeas:reqctx:' + id;
const RCCAP = 24;

// Redact ids/PII from a request path or query VALUE before it goes in a report, keeping only structure/enums. A
// `filter` param or a path segment can carry a private id (Raisin's customerId BAC_… / account TRA_…) — so never
// reveal a value verbatim; replace id-shaped tokens with a placeholder. Enums/keywords/short numbers stay
// readable, which is all the team needs (e.g. `customerId eq [id] & type eq TA_INTERNAL` — enough to author,
// nothing private). Deliberately conservative: when unsure, redact.
export function redactReqVal(v) {
  return String(v == null ? '' : v)
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]')   // JWT
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')     // email
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, '[iban]')                    // IBAN
    .replace(/\b[A-Z]{2,5}_[0-9][0-9_]{3,}\b/g, '[id]')                        // BAC_/TRA_/FDA_/OMA_-style ids
    .replace(/\b\d{7,}\b/g, '[id]')                                            // long numeric id / account number
    .slice(0, 120);
}
export async function pushReqCtx(sourceId, entry) {
  if (!sourceId || !entry) return;
  const k = RCKEY(sourceId);
  try {
    const o = await chrome.storage.local.get(k);
    const arr = Array.isArray(o[k]) ? o[k] : [];
    arr.push({ at: new Date().toISOString(), ...entry });
    await chrome.storage.local.set({ [k]: arr.slice(-RCCAP) });
  } catch (e) { /* best-effort */ }
}
export async function readReqCtx(sourceId) {
  try { const o = await chrome.storage.local.get(RCKEY(sourceId)); return Array.isArray(o[RCKEY(sourceId)]) ? o[RCKEY(sourceId)] : []; } catch (e) { return []; }
}
export async function clearReqCtx(sourceId) { try { await chrome.storage.local.remove(RCKEY(sourceId)); } catch (e) {} }

// Render the request-context ring for the report. Groups nothing — just one compact line per observed
// request so the team can eyeball "which requests carried what and which HTTP status they got".
export function formatReqCtx(list) {
  const es = Array.isArray(list) ? list : [];
  if (!es.length) return '';
  const hms = (s) => { const d = new Date(s * 1000); return isNaN(d) ? '?' : d.toISOString().slice(11, 19); };
  const lines = es.map((e) => {
    const ts = e.at ? '[' + String(e.at).slice(11, 19) + '] ' : '';
    const status = e.status ? ' → HTTP ' + e.status : '';
    const from = e.who ? ' (' + e.who + ')' : '';
    // token issuance (iat/exp) so a working vs failing request reveals a rotated/revoked token — different iat.
    // authfp = fingerprint of the WHOLE Authorization value → same fp ⇒ byte-identical token+scheme (rules out
    // a subtle token/scheme difference the iat can't see).
    const tok = e.tok ? ' token(' + [e.tok.iat != null && ('iat ' + hms(e.tok.iat)), e.tok.exp != null && ('exp ' + hms(e.tok.exp)), e.auth && ('fp ' + e.auth)].filter(Boolean).join(', ') + ')' : (e.auth ? ' token(fp ' + e.auth + ')' : '');
    const ctx = ['origin=' + (e.origin || '∅'), 'referer=' + (e.referer || '∅'), 'cookie=' + (e.cookie ? 'yes' : 'no')].join(' ');
    const query = e.query ? '\n    query: ' + Object.keys(e.query).map((k) => k + '=' + e.query[k]).join(' ') : '';
    // each header shown as name=valuefingerprint (when hashed) so two requests diff value-by-value, not just names
    const names = e.names ? '\n    hdrs: ' + e.names.split(',').map((n) => (e.hh && e.hh[n]) ? n + '=' + e.hh[n] : n).join(' ') : '';
    const order = e.order ? '\n    order: ' + e.order : '';
    return '• ' + ts + (e.method || 'GET') + ' ' + (e.path || '') + status + from + tok + '\n    ' + ctx + query + names + order;
  });
  return '\n\n--- observed requests (redacted; SPA vs our replay) ---\n' + lines.join('\n');
}
