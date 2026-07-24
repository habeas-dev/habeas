// Email sink: one email PER SEND BATCH (one document → one email with its file(s); several documents sent
// together → one email with all of them), carrying the fetched files as ATTACHMENTS + a manifest of the
// normalized records. MV3 has no raw SMTP (no TCP) — so this drives a provider's HTTP send API, with the
// USER's own API key (stored encrypted, like the webdav/s3/dropbox sinks). Data goes straight from the
// user's browser to their chosen provider; nothing routes through Habeas. SW-runnable → works with auto-mode.
//
// Security: an email sink is ONLY user-created in Settings (never proposable by a site via external-hooks —
// exthooks only permits an origin-bound `http` sink), so a page can't route your documents to an arbitrary inbox.
import { getSecret } from '../lib/secrets.js';
import { sigv4Sign, sha256Hex } from '../lib/sigv4.js';
import { toRecords, buildManifest, today } from './format.js';

const CTYPE = { pdf: 'application/pdf', json: 'application/json', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', html: 'text/html', xml: 'application/xml', zip: 'application/zip' };
const ctype = (ext) => CTYPE[String(ext || '').toLowerCase()] || 'application/octet-stream';
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '-');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// base64 of a Blob's bytes (chunked so a large PDF doesn't blow the call stack).
async function blobB64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = ''; const C = 0x8000;
  for (let i = 0; i < bytes.length; i += C) s += String.fromCharCode.apply(null, bytes.subarray(i, i + C));
  return btoa(s);
}
// base64 of a UTF-8 STRING (for MIME parts / RFC 2047 subject).
function strB64(str) {
  const bytes = new TextEncoder().encode(str);
  let s = ''; const C = 0x8000;
  for (let i = 0; i < bytes.length; i += C) s += String.fromCharCode.apply(null, bytes.subarray(i, i + C));
  return btoa(s);
}

const recipients = (sink) => String(sink.to || '').split(',').map((s) => s.trim()).filter(Boolean);
function renderSubject(tpl, vars) {
  const base = tpl || 'Habeas — {service} ({n})';
  return String(base).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}
const attName = (d, ext) => `${(d.date || '').slice(0, 10) || today()}_${safeName(String(d.internalId)).slice(0, 60)}.${ext}`;

// A short human summary of the batch (HTML + plain text) — the body of the email; the data is in the manifest.
function summarize(records, service, n) {
  const line = (r) => {
    const amt = (r.total != null || r.amount != null) ? ` — ${r.total != null ? r.total : r.amount} ${r.currency || ''}`.trimEnd() : '';
    const who = r.description || (r.store && r.store.name) || r.counterparty || r.number || r.internalId || '';
    return `${(r.date || '').slice(0, 10)} · ${who}${amt}`;
  };
  const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:14px;color:#1a1a1a">`
    + `<p>Habeas — <b>${esc(service)}</b> · ${n} ${n === 1 ? 'document' : 'documents'} attached.</p>`
    + `<ul>${records.map((r) => `<li>${esc(line(r))}</li>`).join('')}</ul>`
    + `<p style="color:#777;font-size:12px">Sent by the Habeas browser extension. The full data is in the attached manifest.</p></div>`;
  const text = `Habeas — ${service} · ${n} document(s) attached.\n\n` + records.map((r) => '• ' + line(r)).join('\n');
  return { html, text };
}

// ---- Providers. Each returns a plain request { url, method, headers, body } from a common message shape.
// (SES is handled separately below — it needs SigV4 signing + a raw MIME message.)
const PROVIDERS = {
  // https://resend.com/docs/api-reference/emails/send-email
  resend: (sink, key, m) => ({
    url: 'https://api.resend.com/emails', method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ from: m.from, to: m.to, subject: m.subject, html: m.html, text: m.text, attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.base64 })) }),
  }),
  // https://postmarkapp.com/developer/user-guide/send-email-with-api
  postmark: (sink, key, m) => ({
    url: 'https://api.postmarkapp.com/email', method: 'POST',
    headers: { 'x-postmark-server-token': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ From: m.from, To: m.to.join(','), Subject: m.subject, HtmlBody: m.html, TextBody: m.text, MessageStream: sink.stream || 'outbound', Attachments: m.attachments.map((a) => ({ Name: a.filename, Content: a.base64, ContentType: a.contentType })) }),
  }),
  // https://developers.brevo.com/reference/sendtransacemail
  brevo: (sink, key, m) => ({
    url: 'https://api.brevo.com/v3/smtp/email', method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { email: m.from }, to: m.to.map((e) => ({ email: e })), subject: m.subject, htmlContent: m.html, textContent: m.text, attachment: m.attachments.map((a) => ({ name: a.filename, content: a.base64 })) }),
  }),
  // https://apidoc.smtp2go.com/ (email/send) — key in the X-Smtp2go-Api-Key header (not the body).
  smtp2go: (sink, key, m) => ({
    url: 'https://api.smtp2go.com/v3/email/send', method: 'POST',
    headers: { 'x-smtp2go-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ sender: m.from, to: m.to, subject: m.subject, html_body: m.html, text_body: m.text, attachments: m.attachments.map((a) => ({ filename: a.filename, fileblob: a.base64, mimetype: a.contentType })) }),
  }),
  // https://documentation.mailgun.com/en/latest/api-sending.html — multipart/form-data, Basic auth api:key.
  mailgun: (sink, key, m) => {
    const host = sink.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
    if (!sink.domain) throw new Error('mailgun: sending domain required');
    const fd = new FormData();
    fd.append('from', m.from); for (const to of m.to) fd.append('to', to);
    fd.append('subject', m.subject); fd.append('html', m.html); fd.append('text', m.text);
    for (const a of m.attachments) fd.append('attachment', new Blob([Uint8Array.from(atob(a.base64), (c) => c.charCodeAt(0))], { type: a.contentType }), a.filename);
    return { url: `${host}/v3/${encodeURIComponent(sink.domain)}/messages`, method: 'POST', headers: { authorization: 'Basic ' + btoa('api:' + key) }, body: fd };
  },
};

export function emailHostFor(sink) {
  const p = sink.provider || 'resend';
  if (p === 'mailgun') return sink.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
  if (p === 'ses') return 'https://email.' + (sink.region || 'eu-west-1') + '.amazonaws.com';
  return ({ resend: 'https://api.resend.com', postmark: 'https://api.postmarkapp.com', brevo: 'https://api.brevo.com', smtp2go: 'https://api.smtp2go.com' })[p] || '';
}

// ---- Amazon SES (SendRawEmail): build a MIME message, base64 it, POST SigV4-signed (service 'ses'). ----
function mimeMessage(m) {
  const b = 'habeas_' + strB64(m.subject + m.to.join(',')).replace(/[^a-z0-9]/gi, '').slice(0, 24);
  const enc76 = (s) => s.replace(/(.{76})/g, '$1\r\n');
  const subj = /[^\x00-\x7F]/.test(m.subject) ? `=?UTF-8?B?${strB64(m.subject)}?=` : m.subject;
  const parts = [
    `From: ${m.from}`, `To: ${m.to.join(', ')}`, `Subject: ${subj}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`, '', `--${b}`,
    'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', enc76(strB64(m.html)), '',
  ];
  for (const a of m.attachments) {
    parts.push(`--${b}`, `Content-Type: ${a.contentType}; name="${a.filename}"`, `Content-Disposition: attachment; filename="${a.filename}"`, 'Content-Transfer-Encoding: base64', '', enc76(a.base64), '');
  }
  parts.push(`--${b}--`, '');
  return parts.join('\r\n');
}
async function sendSes(sink, m) {
  const region = sink.region || 'eu-west-1';
  const secret = await getSecret(sink.secretRef);
  if (!sink.accessKeyId || !secret) throw new Error('SES: accessKeyId + secret required');
  const raw = strB64(mimeMessage(m)); // base64 of the (ASCII) MIME message
  const body = 'Action=SendRawEmail&Version=2010-12-01&RawMessage.Data=' + encodeURIComponent(raw);
  const url = 'https://email.' + region + '.amazonaws.com/';
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const { headers } = await sigv4Sign({ method: 'POST', url, region, service: 'ses', accessKeyId: sink.accessKeyId, secretAccessKey: secret, amzDate, payloadHash: await sha256Hex(body), extraHeaders: { 'content-type': 'application/x-www-form-urlencoded' } });
  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error('SES ' + res.status + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160));
}

// Deliver one batch as a single email. Returns { written, total } like every other sink.
export async function emailWrite(sink, docs, files, opts = {}) {
  const to = recipients(sink);
  if (!to.length) throw new Error('email: no recipient');
  if (!sink.from) throw new Error('email: no sender (from)');
  const service = opts.service || 'documents';
  const records = toRecords(docs, files, opts);
  const { html, text } = summarize(records, service, docs.length);
  const attachments = [];
  for (const d of docs) for (const art of files.get(d.internalId) || []) attachments.push({ filename: attName(d, art.ext), contentType: ctype(art.ext), base64: await blobB64(art.blob) });
  const written = attachments.length;
  // The normalized records ride along as a manifest attachment (same JSON the other sinks write).
  attachments.push({ filename: safeName(opts.source || service) + '.json', contentType: 'application/json', base64: strB64(buildManifest(docs, files, opts)) });
  const m = { from: sink.from, to, subject: renderSubject(sink.subject, { service, source: opts.source || service, n: docs.length, date: today() }), html, text, attachments };

  const provider = sink.provider || 'resend';
  if (provider === 'ses') { await sendSes(sink, m); return { written, total: docs.length }; }
  const build = PROVIDERS[provider];
  if (!build) throw new Error('unknown email provider: ' + provider);
  const key = await getSecret(sink.apiKeyRef);
  if (!key) throw new Error(provider + ': API key required');
  const req = build(sink, key, m);
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  if (!res.ok) throw new Error(provider + ' ' + res.status + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160));
  return { written, total: docs.length };
}
