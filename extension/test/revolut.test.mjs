import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory, fetchArtifact, artifactKinds } from '../src/runtime/inventory.js';
import { validateAdapter } from '../src/adapters/validate.js';
import { resolveOutput } from '../src/lib/outputs.js';

const here = dirname(fileURLToPath(import.meta.url));
const ADP = JSON.parse(readFileSync(join(here, '../../sources-repo/sources/revolut.json'), 'utf8'));
const EFF = resolveOutput(ADP, 'transactions'); // the transactions stream (per-account)

// Wholly fictitious transactions. Revolut returns a TOP-LEVEL array; amounts are integer minor units
// (−791 = −7.91) and dates are epoch ms. Paging is "give me rows before this `to` timestamp".
const tx = (id, startedDate, amount, currency, description, type, merchantName) => ({
  id, legId: id, startedDate, completedDate: startedDate, currency, amount, balance: 10000,
  description, type, state: 'COMPLETED', ...(merchantName ? { merchant: { name: merchantName } } : {}),
});
const ALL = [
  tx('t4', 1700000004000, 1000, 'JPY', 'Tokyo Ramen', 'CARD_PAYMENT', 'Tokyo Ramen'), // 0-decimal currency
  tx('t3', 1700000003000, -791, 'EUR', 'Coffee Shop', 'CARD_PAYMENT', 'Coffee Shop'),
  tx('t2', 1700000002000, 900, 'EUR', 'Payment from Jane Doe', 'TOPUP', null),
  tx('t1', 1700000001000, -1250, 'EUR', 'Grocery Store', 'CARD_PAYMENT', 'Grocery Store'),
];
const auth = { merged: { 'x-device-id': 'DEV-abc123' }, byPath: {}, ctx: {} };
// The personal wallet enumerates pockets (per-currency accounts); listing runs once per pocket with
// internalPocketId templated in. Fictitious single EUR pocket here.
const WALLET = { id: 'w1', pockets: [{ id: 'pocket-eur', currency: 'EUR', type: 'CURRENT', state: 'ACTIVE' }] };
const netFor = (rows, seenHeaders) => async (url, init) => {
  if (seenHeaders) seenHeaders.push((init && init.headers) || {});
  const u = new URL(url);
  if (u.pathname === '/api/retail/user/current/wallet') return { ok: true, status: 200, json: async () => WALLET };
  if (u.pathname === '/api/retail/user/current/transactions/last') {
    const to = u.searchParams.get('to');
    const page = to == null ? rows : rows.filter((t) => t.startedDate < Number(to)); // rows OLDER than the cursor
    return { ok: true, status: 200, json: async () => page, text: async () => JSON.stringify(page) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

test('Revolut adapter validates', () => { assert.ok(validateAdapter(ADP).ok, JSON.stringify(validateAdapter(ADP).errors)); });

test('transactions: to-cursor paging, minor-unit scaling, epoch dates, x-device-id replay', async () => {
  const seenHeaders = [];
  const net = async (url, init) => {
    const r = await netFor(ALL, seenHeaders)(url, init);
    if (new URL(url).pathname === '/api/retail/user/current/transactions/last') assert.equal(new URL(url).searchParams.get('count'), '500', 'count param sent every page');
    return r;
  };
  const docs = await listInventory(EFF, auth, net, {});
  // page1 = 4 rows (cursor = min startedDate = t1) → page2 = rows < t1 = none → stop. 4 unique.
  assert.equal(docs.length, 4);
  assert.equal(new Set(docs.map((d) => d.internalId)).size, 4);

  const byId = Object.fromEntries(docs.map((d) => [d.internalId, d.record]));
  assert.equal(byId.t3.amount, -7.91, 'EUR (2 decimals): −791 → −7.91');
  assert.equal(byId.t3.direction, 'debit');
  assert.equal(byId.t2.amount, 9);                                          // 900 → 9.00
  assert.equal(byId.t2.direction, 'credit');
  assert.equal(byId.t4.amount, 1000, 'JPY (0 decimals): 1000 stays 1000, not 10'); // per-currency exponent
  assert.equal(byId.t4.currency, 'JPY');
  assert.equal(byId.t1.date, '2023-11-14');                                // epoch ms → ISO (normalizeDate)
  assert.equal(byId.t3.currency, 'EUR');
  assert.equal(byId.t1.type, 'CARD_PAYMENT');

  // the captured x-device-id (cookie source) is replayed on EVERY API request (wallet + transactions)
  assert.ok(seenHeaders.length >= 2); // /wallet (groups) + transactions
  assert.ok(seenHeaders.every((h) => h['x-device-id'] === 'DEV-abc123'), 'x-device-id replayed on all calls');
  assert.ok(seenHeaders.some((h) => h['x-browser-application'] === 'WEB_CLIENT'), 'static client headers sent on the transactions list');
});

test('per-account filter: pockets enumerate as currency-labelled accounts, listing filters to one', async () => {
  const WALLET2 = { id: 'w1', pockets: [
    { id: 'p-eur', currency: 'EUR', type: 'CURRENT', state: 'ACTIVE' },
    { id: 'p-gbp', currency: 'GBP', type: 'CURRENT', state: 'ACTIVE' },
  ] };
  const perPocket = { 'p-eur': [tx('e1', 1700000001000, -500, 'EUR', 'Shop', 'CARD_PAYMENT', 'Shop')], 'p-gbp': [tx('g1', 1700000002000, -300, 'GBP', 'Pub', 'CARD_PAYMENT', 'Pub')] };
  const net = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/api/retail/user/current/wallet') return { ok: true, status: 200, json: async () => WALLET2 };
    if (u.pathname === '/api/retail/user/current/transactions/last') {
      const pid = u.searchParams.get('internalPocketId'); const to = u.searchParams.get('to');
      const rows = perPocket[pid] || []; const page = to == null ? rows : [];
      return { ok: true, status: 200, json: async () => page, text: async () => JSON.stringify(page) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const both = await listInventory(EFF, auth, net, {}); // all pockets
  assert.equal(both.length, 2);
  assert.deepEqual([...new Set(both.map((d) => d.record.group))].sort(), ['EUR', 'GBP']); // group label = currency
  const eurOnly = await listInventory(EFF, auth, net, { groups: ['p-eur'] }); // saved account filter
  assert.equal(eurOnly.length, 1);
  assert.equal(eurOnly[0].record.currency, 'EUR');
});

test('keepRaw preserves the full transaction detail in record.extra', async () => {
  const docs = await listInventory(EFF, auth, netFor([ALL[0]]), {});
  assert.ok(docs[0].record.extra, 'record.extra present (keepRaw)');
  assert.equal(docs[0].record.extra.state, 'COMPLETED');
});

// Account statements (invoice stream): per pocket × completed month, PDF/CSV, async-generated. The
// account-statements endpoint returns {state} — poll until READY — then the signed Google Storage URL is
// fetched cross-domain (crossDomainHosts + credentials:omit). Verified against the real capture shape.
const STMT = resolveOutput(ADP, 'extracto/pdf');
test('statements: poll account-statements until READY, then cross-domain download of the signed URL', async () => {
  let dlUrl = null, polls = 0;
  const net = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/api/retail/user/current/wallet') return { ok: true, status: 200, json: async () => WALLET };
    if (u.pathname.endsWith('/statements/account-statements')) {
      polls++;
      assert.equal(u.searchParams.get('format'), 'PDF');
      assert.equal(u.searchParams.get('ccy'), 'EUR');
      assert.match(u.searchParams.get('from'), /^\d{4}-\d{2}-01$/);
      assert.match(u.searchParams.get('to'), /^\d{4}-\d{2}-\d{2}$/);
      const body = polls === 1 ? { state: 'IN_PREPARATION' } : { state: 'READY', url: 'https://storage.googleapis.com/revolut-statements/demo.pdf?sig=x' };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }
    if (u.host === 'storage.googleapis.com') { dlUrl = String(url); return { ok: true, status: 200, blob: async () => new Blob(['%PDF']), text: async () => '' }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const docs = await listInventory(STMT, auth, net, {});
  assert.ok(docs.length >= 1, 'synthetic per-month statements listed');
  assert.match(docs[0].internalId, /^EUR-\d{4}-\d{2}$/);
  const kinds = artifactKinds(STMT, docs[0]);
  assert.deepEqual(kinds, [{ kind: 'document', ext: 'pdf' }]);
  const blob = await fetchArtifact(STMT, auth, docs[0], net, null, kinds[0].kind);
  assert.ok(polls >= 2, 'polled through IN_PREPARATION then READY');
  assert.ok(dlUrl && dlUrl.startsWith('https://storage.googleapis.com/'), 'downloaded the signed Google Storage URL');
  assert.ok(blob, 'blob returned');
});
