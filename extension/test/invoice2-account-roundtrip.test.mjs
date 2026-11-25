// An invoice@2 record (Stripe fee invoices) carries its account as `account {id,label}` — the contract with
// Cuéntamo — and NOT the `group` label other schemas persist. Two things read the account back from a STORED
// record (no live `_group`) and both broke on that:
//  - the viewer rebuilds the delivery path to fetch the file back from Dropbox/WebDAV/…; without the account it
//    looked in `stripe/2026/…` while the file had been written to `stripe/<account>/2026/…`;
//  - «Re-download from the site» fills {group.id} in the PDF request (Stripe's per-account header); without it
//    the captured header — whichever account was open — went out and Stripe answered 404.
// The seam test: the path the DELIVERY wrote must be among the paths the RETRIEVAL tries, from the stored record.
// Every value is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord, pathFor } from '../src/sinks/format.js';
import { candidatePaths } from '../src/lib/retrieve.js';
import { fetchPdf } from '../src/runtime/inventory.js';

const ADP = {
  id: 'demo-fees', service: 'demo', schema: 'invoice@2', fields: {},
  api: { host: 'https://dash.example.com', list: { path: '/l', itemsPath: 'data' }, pdf: { path: '/download/{internalId}', headers: { 'x-account': '{group.id}' } } },
};
const SINK = { id: 's1', type: 'dropbox' };
const live = (group) => ({ internalId: 'inv_EXAMPLE1', number: 'X-2026-09', date: '2026-09-30', source: 'demo-fees', _group: group });

for (const [what, group] of [
  ['an account with only an id and a label (Stripe)', { id: 'acct_000EXAMPLEabcd', label: 'Demo shop' }],
  ['an account whose id ends in digits', { id: 'acct_000EXAMPLE1234', label: 'Demo shop' }],
  ['an account with a name', { id: 'acct_000EXAMPLEwxyz', name: 'Demo shop' }],
]) {
  test('invoice@2: the viewer finds the delivered file from the stored record — ' + what, () => {
    const doc = live(group);
    const delivered = pathFor(SINK, doc, { service: 'demo', ext: 'pdf' }, 'pdf');
    assert.notEqual(delivered, 'demo/2026/2026-09-30-inv_EXAMPLE1.pdf'); // it IS under an account folder
    const stored = JSON.parse(JSON.stringify(buildRecord(doc, ADP))); // what the store keeps: no _group
    const tried = candidatePaths(ADP, SINK, stored, 'pdf').map((c) => c.path);
    assert.ok(tried.includes(delivered), delivered + ' not in ' + tried.join(', '));
  });
}

test('invoice@2: re-downloading a stored record sends its own account in the {group.*} header', async () => {
  const stored = JSON.parse(JSON.stringify(buildRecord(live({ id: 'acct_000EXAMPLEabcd', label: 'Demo shop' }), ADP)));
  const doc = { internalId: stored.internalId, date: stored.date, record: stored }; // a row loaded from the store
  const sent = [];
  const net = async (url, init) => { sent.push(init.headers['x-account']); return { ok: true, status: 200, blob: async () => new Blob(['%PDF']) }; };
  await fetchPdf(ADP, { merged: { 'x-account': 'acct_000OPENOTHER' }, byPath: {} }, doc, net);
  assert.deepEqual(sent, ['acct_000EXAMPLEabcd']);
});
