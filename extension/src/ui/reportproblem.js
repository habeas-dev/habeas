// "Report a problem" for an installed source, reachable from the Archive.
//
// The Contributions screen already reports failures, but only inside a handoff THREAD — it needs a
// submission you made. Someone who merely uses a source has no thread and, until now, no way to tell
// anyone that it broke. This module is that path, reusing the same pieces: lib/diag.js accumulates the
// failures, lib/redact.js scrubs them, and the report lands in the same team inbox.
//
// Two rules it must not break:
//  1. NOTHING is sent before the user has seen exactly what would be sent. The preview is the default
//     step, not an option hidden behind a link — this is an extension whose entire argument is that
//     your data stays yours.
//  2. If the user already has a handoff for this source, REPLY to it. `POST /handoff` supersedes any
//     prior submission for the same source, so opening a new one would silently destroy the recording
//     they contributed.
import { chrome } from '../lib/ext.js';
import { formatDiag, clearDiag, readReqCtx, clearReqCtx, formatReqCtx } from '../lib/diag.js';
import { scrubText } from '../lib/redact.js';
import { getSubmitter } from '../lib/submitter.js';
import { submitHandoff, replyHandoff, getMyHandoffs } from '../registry/client.js';
import { getStoredSources } from '../adapters/loader.js';
import { t } from '../lib/i18n.js';
import { esc } from '../lib/esc.js';

const TRACE_LIMIT = 10000;  // fits the handoff service's message limit
const PREVIEW_LIMIT = 4000; // what we show; the sent text is the same, just not truncated for display

async function readDiag(sourceId) {
  try {
    const k = 'habeas:diag:' + sourceId;
    const o = await chrome.storage.local.get(k);
    return o[k] || null;
  } catch (e) { return null; }
}

// Stamp every report with the build and the version ACTUALLY installed, so nobody has to guess which
// combination produced the failure.
async function reportMeta(sourceId) {
  let ext = '';
  try { ext = chrome.runtime.getManifest().version; } catch (e) {}
  let version = '', installed = false;
  try {
    const stored = (await getStoredSources()).find((a) => a.id === sourceId);
    if (stored) { version = String(stored.version || ''); installed = true; }
  } catch (e) {}
  return `Habeas ${ext || '?'} · source ${sourceId}${version ? ' v' + version : ''}${installed ? ' (installed)' : ' (NOT installed)'}`;
}

/** Everything that would leave the machine, as one plain string. Nothing else is ever sent. */
export async function buildReport(sourceId, userNote) {
  const [diag, reqctx, meta] = await Promise.all([
    readDiag(sourceId), readReqCtx(sourceId).catch(() => []), reportMeta(sourceId),
  ]);
  const trace = scrubText(formatDiag(diag) + formatReqCtx(reqctx || ''));
  return {
    hasTrace: !!trace.trim(),
    text: [
      t('report_prefix'),
      '',
      meta,
      (userNote || '').trim() ? '\n' + (userNote || '').trim() : '',
      trace.trim() ? '\n' + trace.slice(0, TRACE_LIMIT) : '\n(' + t('report_no_trace') + ')',
    ].filter(Boolean).join('\n'),
  };
}

/**
 * Which handoff a report belongs to. Exported because getting this wrong is destructive: `POST /handoff`
 * supersedes any prior submission for the same source, so opening a new one when the user already has a
 * thread would silently throw away the recording they contributed.
 * Returns the existing handoff, or null to open a new one.
 */
export function pickHandoff(mine, sourceId) {
  const list = Array.isArray(mine) ? mine : (mine && mine.handoffs) || [];
  return list.find((h) => (h.sourceId || h.source) === sourceId) || null;
}

async function send(sourceId, text) {
  const sub = await getSubmitter();
  let existing = null;
  try { existing = pickHandoff(await getMyHandoffs(sub.id), sourceId); }
  catch (e) { /* offline or unknown submitter — fall through to a new report */ }

  if (existing) { await replyHandoff(existing.id, sub.id, text); return { threaded: true }; }

  await submitHandoff({
    habeasHandoff: 1,
    kind: 'problem-report',
    domain: '',
    sourceId,
    note: 'Problem report from the Archive. No recording attached: this is a failure trace from a user of the source, already redacted client-side.',
    report: text,
  }, sub.id, sub.handle || '', (navigator.languages && navigator.languages[0]) || navigator.language || '');
  return { threaded: false };
}

/**
 * Open the report dialog for a source. Resolves once the dialog closes.
 * `host` is any element to append the dialog to (defaults to document.body).
 */
export async function openReportDialog(sourceId, sourceName, host) {
  const report = await buildReport(sourceId, '');
  const root = document.createElement('div');
  root.className = 'reportdlg';
  root.innerHTML = `
    <div class="rp-scrim"></div>
    <div class="rp-box" role="dialog" aria-modal="true" aria-labelledby="rp-title">
      <h2 id="rp-title">${esc(t('report_title', [sourceName || sourceId]))}</h2>
      <p class="rp-sub">${esc(report.hasTrace ? t('report_sub') : t('report_sub_notrace'))}</p>
      <label class="rp-label" for="rp-note">${esc(t('report_note_label'))}</label>
      <textarea id="rp-note" rows="3" placeholder="${esc(t('report_note_ph'))}"></textarea>
      <details class="rp-peek">
        <summary>${esc(t('report_peek'))}</summary>
        <pre id="rp-preview"></pre>
      </details>
      <p class="rp-priv">${esc(t('report_privacy'))}</p>
      <div class="rp-actions">
        <span id="rp-status" class="rp-status"></span>
        <button id="rp-cancel">${esc(t('cancel'))}</button>
        <button id="rp-send" class="primary">${esc(t('report_send'))}</button>
      </div>
    </div>`;
  (host || document.body).appendChild(root);

  const note = root.querySelector('#rp-note');
  const preview = root.querySelector('#rp-preview');
  const status = root.querySelector('#rp-status');
  const refresh = async () => {
    const r = await buildReport(sourceId, note.value);
    preview.textContent = r.text.slice(0, PREVIEW_LIMIT);
  };
  await refresh();
  note.addEventListener('input', () => { refresh(); });

  return new Promise((resolve) => {
    const close = (v) => { root.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', onKey);
    root.querySelector('.rp-scrim').onclick = () => close(false);
    root.querySelector('#rp-cancel').onclick = () => close(false);
    root.querySelector('#rp-send').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      status.textContent = t('report_sending');
      try {
        const { text } = await buildReport(sourceId, note.value);
        const { threaded } = await send(sourceId, text);
        // Clear only after the service accepted it, so a failed send never loses the trace.
        await clearDiag(sourceId); await clearReqCtx(sourceId).catch(() => {});
        status.textContent = threaded ? t('report_sent_thread') : t('report_sent');
        setTimeout(() => close(true), 1400);
      } catch (err) {
        btn.disabled = false;
        status.textContent = t('report_fail', [String((err && err.message) || err).slice(0, 60)]);
      }
    };
  });
}
