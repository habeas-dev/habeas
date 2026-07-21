// The failure diagnostic accumulates a structured entry PER failed request (not a single overwritten
// error), and renders it so "Report a problem" tells the team which request failed. All values synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LOCAL = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => (k in LOCAL ? { [k]: LOCAL[k] } : {}),
  set: async (o) => { Object.assign(LOCAL, o); },
  remove: async (k) => { delete LOCAL[k]; },
} } };
const { pushDiag, readDiag, clearDiag, formatDiag, recordingNet, pushReqCtx, readReqCtx, clearReqCtx, formatReqCtx, redactReqVal } = await import('../src/lib/diag.js');

test('redactReqVal strips ids from a query value/path but keeps the filter STRUCTURE + enums', () => {
  // The privacy bug: an earlier build revealed filter=customerId eq BAC_111_929_601_280 verbatim. Synthetic id.
  assert.equal(redactReqVal('customerId eq BAC_222_333_444_555 & type eq TA_INTERNAL'), 'customerId eq [id] & type eq TA_INTERNAL');
  assert.equal(redactReqVal('/tams/v1/accounts/TRA_900_800_700_600/transactions'), '/tams/v1/accounts/[id]/transactions');
  assert.equal(redactReqVal('/cas/public/v1/customers/BAC_222_333_444_555'), '/cas/public/v1/customers/[id]');
  assert.equal(redactReqVal('12345678'), '[id]');            // long numeric account id
  assert.equal(redactReqVal('ES9121000418450200051332'), '[iban]');
  assert.equal(redactReqVal('someone@example.com'), '[email]');
  // enums / paging / dates / short numbers are NOT touched — the team still sees them
  for (const keep of ['all', 'es-ES', 'availability', 'asc', '10', 'TA_INTERNAL', 'active']) assert.equal(redactReqVal(keep), keep);
});

test('pushDiag accumulates multiple failures (does not overwrite) and clearDiag removes them', async () => {
  for (const k of Object.keys(LOCAL)) delete LOCAL[k];
  await pushDiag('feci', { phase: 'document', output: 'extractos', item: '01/09/2025', message: 'statement 500', status: 500 });
  await pushDiag('feci', { phase: 'document', output: 'extractos', item: '01/08/2025', message: 'statement 500', status: 500 });
  const d = await readDiag('feci');
  assert.equal(d.entries.length, 2, 'both failures are kept, not just the first/last');
  assert.equal(d.entries[0].item, '01/09/2025');
  assert.equal(d.entries[1].item, '01/08/2025');
  await clearDiag('feci');
  assert.equal(await readDiag('feci'), null);
});

test('formatDiag renders which request failed (timestamp, output, item, HTTP status, method + url)', () => {
  const txt = formatDiag({ entries: [
    { at: '2026-07-20T10:04:52.123Z', phase: 'document', output: 'extractos', kind: 'document', item: '01/09/2025', message: 'statement 500 internal error', status: 500, method: 'POST', url: 'https://x.test/dashboard/.../generate-file?datePurchase=01/09/2025' },
  ] });
  assert.match(txt, /\[2026-07-20 10:04:52\]/, 'each line is timestamped');
  assert.match(txt, /output=extractos/);
  assert.match(txt, /item=01\/09\/2025/);
  assert.match(txt, /HTTP 500/);
  assert.match(txt, /POST https:\/\/x\.test\/dashboard/);
});

test('formatDiag is back-compatible with the old single-error shape, and empty is blank', () => {
  assert.equal(formatDiag({ error: 'groups 401 [sent: accept]', at: 'x' }), 'groups 401 [sent: accept]');
  assert.equal(formatDiag(null), '');
  assert.equal(formatDiag({ entries: [] }), '');
});

test('reqctx ring accumulates redacted contexts and clears; format diffs a working vs failing request', async () => {
  for (const k of Object.keys(LOCAL)) delete LOCAL[k];
  // The SPA's own /accounts request (works) vs our replay (401): same path, the report lets the team eyeball
  // the difference (here: the working one carried a cookie, ours did not).
  // The working request carries a NEWER token issuance (later iat) than our failing replay — the rotated/
  // revoked-but-unexpired token that reads "valid" by exp yet is rejected. Synthetic epochs.
  // The working request carries a NEWER token issuance (later iat) than our failing replay — the rotated/
  // revoked-but-unexpired token that reads "valid" by exp yet is rejected. Per-header value fingerprints (hh)
  // let us confirm every OTHER header is byte-identical (same hash) — here sec-fetch-site DIFFERS. Synthetic.
  // Working vs failing now diff on: token (same iat + same auth fp ⇒ identical token), the QUERY (filter=<X> vs
  // filter=all — the query my earlier build stripped), and header ORDER. Synthetic.
  await pushReqCtx('raisin-es', { path: '/tams/v1/accounts', method: 'GET', origin: 'www.raisin.com', referer: 'www.raisin.com/es-es', cookie: false, names: 'accept,authorization,sec-fetch-site', status: 200, tok: { iat: 1_800_000_300, exp: 1_800_001_200 }, auth: 'auth9', hh: { accept: 'aaa', 'sec-fetch-site': 'xxx' }, query: { filter: 'type:CURRENT,SAVINGS' }, order: 'accept,authorization,sec-fetch-site' });
  await pushReqCtx('raisin-es', { path: '/tams/v1/accounts', method: 'GET', origin: 'www.raisin.com', referer: 'www.raisin.com/es-es', cookie: false, names: 'accept,authorization,sec-fetch-site', status: 401, tok: { iat: 1_800_000_300, exp: 1_800_001_200 }, auth: 'auth9', hh: { accept: 'aaa', 'sec-fetch-site': 'xxx' }, query: { filter: 'all' }, order: 'authorization,accept,sec-fetch-site' });
  const list = await readReqCtx('raisin-es');
  assert.equal(list.length, 2);
  const txt = formatReqCtx(list);
  assert.match(txt, /HTTP 200/);
  assert.match(txt, /HTTP 401/);
  assert.match(txt, /token\(iat \d\d:\d\d:\d\d, exp \d\d:\d\d:\d\d, fp auth9\)/, 'token issuance + a whole-Authorization fingerprint are rendered');
  assert.match(txt, /accept=aaa/, 'header VALUE fingerprint is shown, not just the name');
  assert.match(txt, /query: filter=type:CURRENT,SAVINGS/, 'safe query param is revealed verbatim (the value the earlier build hid)');
  assert.match(txt, /query: filter=all/);
  assert.match(txt, /order: accept,authorization,sec-fetch-site/, 'raw header order is shown to catch order-fingerprint rejection');
  assert.match(txt, /\bauthorization\b(?!=)/, 'authorization is listed but NOT value-hashed inline (covered by the fp)');
  await clearReqCtx('raisin-es');
  assert.deepEqual(await readReqCtx('raisin-es'), []);
});

test('formatReqCtx empty is blank', () => { assert.equal(formatReqCtx([]), ''); assert.equal(formatReqCtx(null), ''); });

test('recordingNet remembers the LAST request issued (which one failed in a multi-step fetch)', async () => {
  const net = async (u) => ({ status: /generate-file/.test(u) ? 500 : 200, ok: !/generate-file/.test(u) });
  const rec = recordingNet(net);
  await rec.net('https://x.test/list', { method: 'GET' });
  await rec.net('https://x.test/generate-file', { method: 'POST' });
  assert.equal(rec.ref.last.method, 'POST');
  assert.equal(rec.ref.last.url, 'https://x.test/generate-file');
  assert.equal(rec.ref.last.status, 500);
});
