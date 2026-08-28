import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory } from '../src/runtime/inventory.js';
import { resolveOutput } from '../src/lib/outputs.js';
import { checkBalanceContinuity } from '../src/lib/reconcile.js';

// Reported against 167 real Revolut movements. 151 of 166 balance links already chained to the cent, so
// the ingest was right in the general case; two narrow shapes accounted for everything that was wrong.
//
//  - 14 card verifications: the 0 EUR authorisation a merchant makes to check a card is live. The zero is
//    CORRECT — they move no money — but they are not movements, and emitting them puts 0,00 entries in
//    someone's ledger. Separation in the sample was perfect: all 14 zero-amount rows carried
//    cardVerification, and none of the 153 with an amount did.
//  - 15 vault transfers: booked from the paying side, so money returning FROM a savings vault arrived
//    negative like the money going to it; and each carried the VAULT's closing balance rather than the
//    personal account's, which made the running series jump by thousands at exactly those rows.
//
// Together those two explain the whole −10.253,24 against a real balance movement of 7,56. Nothing was
// missing; the arithmetic was being fed the wrong signs and someone else's balances.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ADP = resolveOutput(JSON.parse(readFileSync(join(ROOT, 'sources-repo/sources/revolut.json'), 'utf8')), 'transactions');
const AUTH = { merged: {}, byPath: {}, ctx: {} };
// The stream is grouped by POCKET, so the wallet has to be served before any transaction is asked for.
const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
const feed = (items) => async (url) => (String(url).includes('/wallet')
  ? ok({ pockets: [{ id: 'p1', currency: 'EUR', type: 'CURRENT' }] })
  : ok(items));
const ids = (docs) => docs.map((d) => d._raw.id).sort(); // the SOURCE's own id: internalId is now the natural key

const CARD_VERIFICATION = {
  id: 'CV1', startedDate: '2025-02-24', amount: 0, currency: 'EUR', balance: 100000, state: 'COMPLETED',
  description: 'Amazon.es', type: 'CARD_PAYMENT', cardVerification: true,
};
const NORMAL = { id: 'N1', startedDate: '2025-02-25', amount: -1250, currency: 'EUR', balance: 98750, state: 'COMPLETED', description: 'Dinahosting' };
const vault = (id, date, amount, bal, from, to) => ({
  id, startedDate: date, amount, currency: 'EUR', balance: bal, description: 'Vault', state: 'COMPLETED',
  vault: { id: 'v1' }, fromAccount: { type: from }, toAccount: { type: to },
});

test('a card verification is not emitted — it moves no money and is not a movement', async () => {
  const docs = await listInventory(ADP, AUTH, feed([CARD_VERIFICATION, NORMAL]), {});
  assert.deepEqual(ids(docs), ['N1'], 'the 0 EUR authorisation must not reach the ledger');
});

test('…and the filter keys off the FLAG, not off the amount being zero', async () => {
  // The zero is correct here, so treating "amount === 0" as the signal would be right by accident and
  // wrong in principle — and would drop any genuine zero another source might have.
  const zeroButReal = { ...CARD_VERIFICATION, id: 'Z1', cardVerification: false, amount: 0 };
  const docs = await listInventory(ADP, AUTH, feed([zeroButReal]), {});
  // The runtime's own zero-amount guard still catches it, but for its own reason; what matters here is
  // that the SOURCE does not claim to filter on the amount.
  const src = JSON.parse(readFileSync(join(ROOT, 'sources-repo/sources/revolut.json'), 'utf8'));
  const keep = src.streams.find((s) => s.id === 'transactions').api.list.keep;
  const flag = keep.find((k) => k.field === 'cardVerification');
  assert.ok(flag, 'the flag is the signal, not the amount');
  assert.deepEqual(flag.exclude, [true]);
  assert.equal(docs.length, 0);
});

test('money coming back FROM a vault arrives positive, not negative', async () => {
  // Revolut books it from the paying account's side: the vault lost the money, so the record is negative
  // even though the personal account gained it.
  const docs = await listInventory(ADP, AUTH, feed([vault('V1', '2025-03-01', -200536, 0, 'SAVINGS', 'PERSONAL')]), {});
  assert.equal(docs.length, 1);
  assert.equal(docs[0].amount, 2005.36, 'an incoming vault transfer must be positive');
});

test('money going INTO a vault stays negative', async () => {
  const docs = await listInventory(ADP, AUTH, feed([vault('V2', '2025-03-02', -50000, 0, 'PERSONAL', 'SAVINGS')]), {});
  assert.equal(docs[0].amount, -500);
});

test('a vault transfer carries no balance, because the one it has is the vault\'s', async () => {
  // The reported giveaway: balance 0,00 immediately after receiving 2.005,36 EUR — impossible in the
  // personal account, and exactly right for a vault that has just been emptied.
  const docs = await listInventory(ADP, AUTH, feed([vault('V3', '2025-03-03', -200536, 0, 'SAVINGS', 'PERSONAL')]), {});
  assert.equal(docs[0].balanceAfter, undefined, 'better absent than confidently wrong');
});

test('ordinary movements are left completely alone', async () => {
  // The rules are scoped to rows carrying a vault. 151 of 166 links already chained; none of that may move.
  const docs = await listInventory(ADP, AUTH, feed([NORMAL]), {});
  assert.equal(docs[0].amount, -12.5);
  assert.equal(docs[0].balanceAfter, 987.5);
});

test('with both fixed, the statement adds up — which is what failed by 10.260,80', async () => {
  const items = [
    { id: 'A', startedDate: '2025-03-01', amount: 100000, currency: 'EUR', balance: 100000, state: 'COMPLETED', description: 'Salary' },
    CARD_VERIFICATION,                                                        // dropped: not a movement
    { ...vault('B', '2025-03-02', -40000, 0, 'PERSONAL', 'SAVINGS'), balance: 60000 }, // -400, balance is the vault's
    { id: 'C', startedDate: '2025-03-03', amount: -10000, currency: 'EUR', balance: 50000, state: 'COMPLETED', description: 'Rent' },
    vault('D', '2025-03-04', -40000, 0, 'SAVINGS', 'PERSONAL'),               // +400 back, balance is the vault's
    { id: 'E', startedDate: '2025-03-05', amount: -5000, currency: 'EUR', balance: 85000, state: 'COMPLETED', description: 'Shopping' },
  ];
  const docs = await listInventory(ADP, AUTH, feed(items), {});
  assert.deepEqual(ids(docs), ['A', 'B', 'C', 'D', 'E'], 'only the verification is dropped');
  const r = checkBalanceContinuity(docs);
  assert.equal(r.ok, true, `the corrected series must close: ${JSON.stringify(r.runs)}`);

  // And the sum is right in the only way that matters: it equals what the balance actually did.
  const sum = docs.reduce((s, d) => s + d.amount, 0);
  assert.equal(Math.round(sum * 100) / 100, 850, '1000 - 400 - 100 + 400 - 50');
});

test('minor units divide, so an amount is the number a person would write', async () => {
  // 200536 * 0.01 is 2005.3600000000001: the reciprocal of 100 is not exactly representable. Dividing
  // lands on the nearest double to 2005.36. Invisible until a few thousand movements are summed, or
  // until someone reads it — and this is a ledger, so both happen.
  const docs = await listInventory(ADP, AUTH, feed([
    { id: 'F1', startedDate: '2025-04-01', amount: 200536, currency: 'EUR', balance: 200536, state: 'COMPLETED', description: 'x' },
    { id: 'F2', startedDate: '2025-04-02', amount: -1071, currency: 'EUR', balance: 199465, state: 'COMPLETED', description: 'y' },
  ]), {});
  const by = Object.fromEntries(docs.map((d) => [d._raw.id, d])); // by the SOURCE's own id: internalId is now the natural key
  assert.equal(by.F1.amount, 2005.36);
  assert.equal(by.F2.amount, -10.71);
  assert.equal(by.F2.balanceAfter, 1994.65);
  assert.equal(String(by.F1.amount), '2005.36', 'and it must READ correctly, not merely compare closely');
});

// ---------------------------------------------------------------- declined and reverted charges

test('a declined or reverted charge is not emitted — its successful twin already is', async () => {
  // A card is refused, the payment is retried, and the good one arrives too. Emitting all three books
  // the purchase three times. In the sample the discriminator was again perfect: the 6 DECLINED/REVERTED
  // rows were exactly the 6 arriving with no balance, and no COMPLETED row lacked one.
  const docs = await listInventory(ADP, AUTH, feed([
    { id: 'D1', startedDate: '2025-05-01', amount: -8950, currency: 'EUR', state: 'DECLINED', description: 'Shop' },
    { id: 'R1', startedDate: '2025-05-01', amount: -8950, currency: 'EUR', state: 'REVERTED', description: 'Shop' },
    { id: 'G1', startedDate: '2025-05-01', amount: -8950, currency: 'EUR', balance: 41050, state: 'COMPLETED', description: 'Shop' },
  ]), {});
  assert.deepEqual(ids(docs), ['G1'], 'only the charge that actually happened');
});

test('the state filter is a WHITELIST, so a state Revolut invents later stays out', async () => {
  // A blacklist would silently admit PENDING or PROCESSING the day they appear, and nobody would know
  // what they mean until the balances stopped adding up again.
  const src = JSON.parse(readFileSync(join(ROOT, 'sources-repo/sources/revolut.json'), 'utf8'));
  const rule = src.streams.find((s) => s.id === 'transactions').api.list.keep.find((k) => k.field === 'state');
  assert.deepEqual(rule.values, ['COMPLETED']);
  assert.equal(rule.exclude, undefined, 'a blacklist here would admit tomorrow\'s unknown states');
  const docs = await listInventory(ADP, AUTH, feed([
    { id: 'P1', startedDate: '2025-06-01', amount: -100, currency: 'EUR', state: 'PENDING', description: 'later' },
  ]), {});
  assert.equal(docs.length, 0);
});

test('a TRANSFER without vault/fromAccount is left completely alone', async () => {
  // Called out in the report: the sample holds 2 plain TRANSFERs with no fromAccount/toAccount. Keying
  // the sign rule off type === "TRANSFER" would have flipped those for no reason.
  const docs = await listInventory(ADP, AUTH, feed([
    { id: 'T1', startedDate: '2025-07-01', amount: -25000, currency: 'EUR', balance: 75000, state: 'COMPLETED', type: 'TRANSFER', description: 'To someone' },
  ]), {});
  assert.equal(docs[0].amount, -250, 'an ordinary transfer keeps its sign');
  assert.equal(docs[0].balanceAfter, 750, 'and keeps its balance');
});

test('the reported shape end to end: 20 dropped of three kinds, and the rest closes', async () => {
  // Mirrors the sample's headline: 167 movements in, 147 out, 20 discarded — 14 card verifications, 5
  // declined and 1 reverted — and a statement that adds up once the vault rows are read from the right
  // side. The counts here are the same three kinds in the same proportions, not the same volume.
  const items = [];
  let bal = 100000;                                     // 1000,00 EUR in minor units
  const real = (id, amt, date) => { bal += amt; return { id, startedDate: date, amount: amt, currency: 'EUR', balance: bal, state: 'COMPLETED', description: id }; };

  items.push(real('S', 200000, '2025-01-01'));           // +2000
  for (let i = 0; i < 14; i++)                           // 14 verifications: no money, no balance change
    items.push({ id: 'CV' + i, startedDate: '2025-01-02', amount: 0, currency: 'EUR', balance: bal, state: 'COMPLETED', type: 'CARD_PAYMENT', cardVerification: true });
  for (let i = 0; i < 5; i++)                            // 5 declined: never happened, and carry no balance
    items.push({ id: 'DEC' + i, startedDate: '2025-01-03', amount: -4500, currency: 'EUR', state: 'DECLINED', description: 'retry' });
  items.push({ id: 'REV', startedDate: '2025-01-03', amount: -4500, currency: 'EUR', state: 'REVERTED', description: 'retry' });
  items.push(real('OK', -4500, '2025-01-04'));           // the charge that did happen
  // Two vault movements, as Revolut books them: negative from the payer's side, carrying the VAULT's balance.
  items.push({ id: 'V-out', startedDate: '2025-01-05', amount: -50000, currency: 'EUR', balance: 50000, state: 'COMPLETED', vault: { id: 'v' }, fromAccount: { type: 'PERSONAL' }, toAccount: { type: 'SAVINGS' } });
  bal -= 50000;
  items.push({ id: 'V-in', startedDate: '2025-01-06', amount: -20000, currency: 'EUR', balance: 30000, state: 'COMPLETED', vault: { id: 'v' }, fromAccount: { type: 'SAVINGS' }, toAccount: { type: 'PERSONAL' } });
  bal += 20000;
  items.push(real('END', -1000, '2025-01-07'));

  const docs = await listInventory(ADP, AUTH, feed(items), {});
  assert.equal(items.length, 25, '5 real movements plus the 20 that should never be emitted');
  assert.equal(docs.length, 5, 'S, OK, V-out, V-in and END survive; the other 20 do not');
  assert.equal(docs.filter((d) => d.internalId.startsWith('CV')).length, 0);
  assert.equal(docs.filter((d) => /^(DEC|REV)/.test(d.internalId)).length, 0);

  // The sign is corrected on the way in, which is what makes the sum meaningful at all.
  const by = Object.fromEntries(docs.map((d) => [d._raw.id, d])); // by the SOURCE's own id: internalId is now the natural key
  assert.equal(by['V-out'].amount, -500);
  assert.equal(by['V-in'].amount, 200, 'money returning from the vault is income');
  assert.equal(by['V-out'].balanceAfter, undefined, 'the vault\'s balance must not enter the series');

  const r = checkBalanceContinuity(docs);
  assert.equal(r.ok, true, `the corrected statement must close: ${JSON.stringify(r.runs)}`);
});
