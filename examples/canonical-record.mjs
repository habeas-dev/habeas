// Generates examples/canonical-record.json — the sample of what a destination receives when it opts into
// the uniform canonical record shape (`sink.normalize`). It is GENERATED rather than hand-written so it
// cannot drift from the code: every entry is a fully synthetic record run through the real
// `canonicalize()`, and a test (extension/test/example-canonical.test.mjs) fails if the committed file
// stops matching. The file is linked publicly from the developers page, so a stale sample would be a
// contract published wrong.
//
// Regenerate with:  node examples/canonical-record.mjs
//
// NOTHING here comes from a real capture: the accounts, names, merchants and amounts are all invented.
// The IBAN is a valid-by-checksum but obviously fictional number (body all zeros bar the tail); the
// current-account balances are internally consistent, since a statement that did not add up would be a
// poor example of a format whose whole point is that it does.
import { canonicalize } from '../extension/src/lib/normalize.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Records as sinks/format.js#buildRecord emits them, before canonicalize. transaction@1 only — what a
// destination declaring accepts:{schemas:['transaction']} is offered. Balances on the current account:
//   2406.18 - 42.50 = 2363.68 - 68.90 = 2294.78 - 15.00 = 2279.78
const BUILT = [
  // salary in — structured account derived from an IBAN
  { internalId: 'mv-2026-04-10-01', date: '2026-04-10', amount: 1850.00, currency: 'EUR',
    category: 'income', description: 'Incoming transfer SALARY APRIL', counterparty: 'Vela Studio Ltd',
    direction: 'credit', source: 'demo-bank:movements', type: 'TRANSFER',
    account: 'ES3500000000000000001234', valueDate: '2026-04-10', balanceAfter: 2406.18 },

  // instant transfer out — `counterparty` was extracted from the free text by the adapter's
  // normalize.counterparty rule, which is why the clean name sits beside the raw description
  { internalId: 'mv-2026-04-14-01', date: '2026-04-14', amount: -42.50, currency: 'EUR',
    category: 'transfer', description: 'Instant transfer sent to Laura Bennett', counterparty: 'Laura Bennett',
    direction: 'debit', source: 'demo-bank:movements', type: 'INSTANT_TRANSFER',
    account: 'ES3500000000000000001234', valueDate: '2026-04-14', balanceAfter: 2363.68 },

  // direct debit — value date differs from booking date; `extra` carries what the schema did not consume
  { internalId: 'mv-2026-04-16-01', date: '2026-04-16', amount: -68.90, currency: 'EUR',
    category: 'utilities', description: 'Direct debit electricity March', counterparty: 'Hidrolux Energy',
    direction: 'debit', source: 'demo-bank:movements', type: 'DIRECT_DEBIT',
    account: 'ES3500000000000000001234', valueDate: '2026-04-17', balanceAfter: 2294.78,
    extra: { reference: 'REC-4471-0093', mandate: 'ES91ZZZA00000000' } },

  // card purchase from a grouped source: no IBAN, identified by last4 + its group; no running balance
  { internalId: 'cd-2026-04-15-07', date: '2026-04-15', amount: -23.40, currency: 'EUR',
    category: 'retail', description: 'THE CORNER BAKERY', counterparty: 'The Corner Bakery',
    direction: 'debit', source: 'demo-card:movements', type: 'PURCHASE',
    group: 'Classic Card 4417', extra: { location: 'BRISTOL' } },

  // card refund — a credit on the same card
  { internalId: 'cd-2026-04-18-02', date: '2026-04-18', amount: 12.75, currency: 'EUR',
    category: 'retail', description: 'REFUND THE CORNER BAKERY', counterparty: 'The Corner Bakery',
    direction: 'credit', source: 'demo-card:movements', type: 'REFUND',
    group: 'Classic Card 4417', extra: { location: 'BRISTOL' } },

  // a source that regenerates its ids on each sync says so, so the consumer keys on its own composite
  { internalId: 'mv-2026-04-19-01', date: '2026-04-19', amount: -15.00, currency: 'EUR',
    category: 'fee', description: 'Account maintenance fee', counterparty: 'Demo Bank',
    direction: 'debit', source: 'demo-bank:movements', type: 'FEE',
    account: 'ES3500000000000000001234', balanceAfter: 2279.78, idStable: false },

  // --- Non-IBAN countries. Nothing is forced through an IBAN, and `currency` is whatever the source
  // reported — it is never coerced to EUR. Two routes, both supported: ---

  // (a) the adapter maps `account` to an OBJECT, which travels verbatim, so a scheme the runtime does not
  //     model keeps its own identifiers — here a US routing + account number.
  { internalId: 'us-2026-04-12-01', date: '2026-04-12', amount: -85.20, currency: 'USD',
    category: 'utilities', description: 'ACH DEBIT CITY WATER DEPT', counterparty: 'City Water Dept',
    direction: 'debit', source: 'demo-us-bank:movements', type: 'ACH_DEBIT',
    account: { routingNumber: '021000021', accountNumber: '1234567890', type: 'checking' },
    balanceAfter: 1204.55 },

  // (b) the adapter reports the account as a STRING that is not an IBAN — a UK sort code plus account
  //     number. No `iban` is invented; the account is identified by its last four digits.
  { internalId: 'gb-2026-04-13-01', date: '2026-04-13', amount: -19.99, currency: 'GBP',
    category: 'retail', description: 'CARD PAYMENT NORTHGATE BOOKS', counterparty: 'Northgate Books',
    direction: 'debit', source: 'demo-gb-bank:movements', type: 'CARD_PAYMENT',
    account: '12-34-56 12345678', balanceAfter: 640.10 },
];

// `pdf` is added by sinks/format.js#toRecords: whether a document file accompanied the record.
const HAS_PDF = new Set(['mv-2026-04-16-01']);

export function buildSample() {
  return BUILT.map((r) => ({ ...canonicalize(r), pdf: HAS_PDF.has(r.internalId) }));
}
export const SAMPLE_PATH = new URL('./canonical-record.json', import.meta.url);
export const serialize = (rows) => JSON.stringify(rows, null, 2) + '\n';

// Only write when run directly, so the test can import buildSample() without touching the file.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(SAMPLE_PATH, serialize(buildSample()));
  console.log(`wrote ${fileURLToPath(SAMPLE_PATH)} (${buildSample().length} records)`);
}
