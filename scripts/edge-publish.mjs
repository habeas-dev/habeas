#!/usr/bin/env node
// Publish the Edge package to Microsoft Edge Add-ons (Update REST API v1.1).
//
//   node scripts/edge-publish.mjs <package.zip> [notes-file]
//
// Env: EDGE_PRODUCT_ID, EDGE_CLIENT_ID, EDGE_API_KEY.
//
// The API answers everything through an operation poll, and the difference between "still working",
// "already in review" and "genuinely broken" lives only in that payload. Two of its failures are not
// failures at all — NoModulesUpdated (the store already has this build) and InProgressSubmission (the
// previous version is still queued) — and treating them as errors would fail healthy releases the way
// Chrome's ITEM_NOT_UPDATABLE did for days. Everything else is reported loudly, with the validation
// errors verbatim, because a publish path that quietly does nothing is worse than no publish path.
export const BASE = 'https://api.addons.microsoftedge.microsoft.com/v1';

export const headers = (apiKey, clientId) => ({ Authorization: `ApiKey ${apiKey}`, 'X-ClientID': clientId });

/** `{ done, ok, note }` for an operation payload. Pure, so the decisions above are testable. */
export function classifyOperation(op) {
  if (!op || typeof op !== 'object' || !op.status) {
    return { done: true, ok: false, note: 'the API returned no operation status — treating as failed' };
  }
  if (op.status === 'InProgress') return { done: false, ok: true, note: 'in progress' };
  if (op.status === 'Succeeded') return { done: true, ok: true, note: op.message || 'succeeded' };

  // Failed — but two of these mean "nothing to do", not "something broke".
  if (op.errorCode === 'NoModulesUpdated') {
    return { done: true, ok: true, note: 'nothing to publish — the store already has this build' };
  }
  if (op.errorCode === 'InProgressSubmission') {
    return { done: true, ok: true, note: 'a submission is already in review — this build will wait its turn' };
  }
  const errs = Array.isArray(op.errors)
    ? op.errors.map((e) => (typeof e === 'string' ? e : e && e.message)).filter(Boolean).join(' · ')
    : '';
  return { done: true, ok: false, note: [op.errorCode, op.message, errs].filter(Boolean).join(' — ') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(url, h, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: h });
    const body = await res.json().catch(() => null);
    const v = classifyOperation(body);
    if (v.done) return v;
    await sleep(5000);
  }
  return { done: true, ok: false, note: `${label}: still in progress after 5 minutes` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [zip, notesFile] = process.argv.slice(2);
  const { EDGE_PRODUCT_ID: product, EDGE_CLIENT_ID: clientId, EDGE_API_KEY: apiKey } = process.env;
  if (!zip) { console.error('usage: edge-publish.mjs <package.zip> [notes-file]'); process.exit(2); }
  if (!product || !clientId || !apiKey) {
    console.error('EDGE_PRODUCT_ID / EDGE_CLIENT_ID / EDGE_API_KEY not set — refusing to pretend it published');
    process.exit(2);
  }
  const { readFileSync } = await import('node:fs');
  const h = headers(apiKey, clientId);

  const up = await fetch(`${BASE}/products/${product}/submissions/draft/package`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/zip' }, body: readFileSync(zip),
  });
  if (up.status !== 202) { console.error(`upload failed: HTTP ${up.status} ${await up.text()}`); process.exit(1); }
  const upOp = up.headers.get('location');
  const upV = await poll(`${BASE}/products/${product}/submissions/draft/package/operations/${upOp}`, h, 'upload');
  console.log('upload:', upV.note);
  if (!upV.ok) process.exit(1);

  // Notes for certification are required on EVERY submission; the store flags submissions without them.
  const notes = notesFile ? readFileSync(notesFile, 'utf8') : 'Automated release. See the repository for build provenance.';
  const pub = await fetch(`${BASE}/products/${product}/submissions`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'text/plain' }, body: notes,
  });
  if (pub.status !== 202) { console.error(`publish failed: HTTP ${pub.status} ${await pub.text()}`); process.exit(1); }
  const pubOp = pub.headers.get('location');
  const pubV = await poll(`${BASE}/products/${product}/submissions/operations/${pubOp}`, h, 'publish');
  console.log('publish:', pubV.note);
  process.exit(pubV.ok ? 0 : 1);
}
