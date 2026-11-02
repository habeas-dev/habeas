// A fake BANK + BROKER for end-to-end tests of Habeas, and of the apps that consume it, against something
// that behaves like a real service: a logged-in SPA that sends a JWT to its own API (so the in-session hook
// captures it), an accounts endpoint, paginated movements per account (newest first, with value date and
// running balance), and a broker timeline (buys, a sell, a dividend with tax withheld, cash in/out, interest,
// a fee). Its API speaks its OWN field names, like any bank; the source maps them to Habeas's schemas.
//
// TEST ONLY. The service, its data and `fakeBankSource()` are fictional and loopback-bound: they are never
// shipped in the extension nor published to the registry (the validator allows http only for localhost).
//
// Determinism: the data is fixed, so a consumer can assert exact amounts and balances. To exercise an
// incremental sync, the control API appends movements or trades; `reset` puts everything back.
//   POST /__control/movement {account, date, amount, concept}  → appends one movement (id + balance assigned)
//   POST /__control/trade    {date, side, isin, units, price, …} → appends one broker record
//   POST /__control/reset                                         → back to the fixed data set
//   GET  /__control/state                                         → counts per account + broker
import http from 'node:http';

const PAGE_SIZE = 10;
const TOKEN = 'bearer eyJmYWtlYmFuaw.e2e.token';

// The IBANs are valid (ISO 13616 mod-97), like a real bank's.
export const FAKE_ACCOUNTS = [
  // `number` is what the bank shows as the account identifier: the IBAN, or a card's masked PAN.
  { id: 'ACC-CURRENT', name: 'Current Account', number: 'ES9121000418450200051332', currency: 'EUR', opening: 1250.0 },
  { id: 'ACC-SAVINGS', name: 'Savings Account', number: 'ES7921000813610123456789', currency: 'EUR', opening: 5000.0 },
  { id: 'CARD-4242', name: 'Visa Card', number: '**** 4242', currency: 'EUR', opening: 0 },
];
export const FAKE_BROKER_ACCOUNT = 'FAKEBROKER-001';

// [account, date, amount, concept]. Enough movements in the payroll account to need three pages.
const BASE_MOVEMENTS = [
  ['ACC-CURRENT', '2026-09-01', 2150.0, 'SALARY ACME SOLUTIONS LTD'],
  ['ACC-CURRENT', '2026-09-02', -650.0, 'RENT PAYMENT'],
  ['ACC-CURRENT', '2026-09-03', -84.37, 'GROCERY STORE PURCHASE'],
  ['ACC-CURRENT', '2026-09-05', -500.0, 'TRANSFER TO SAVINGS ACCOUNT'],
  ['ACC-CURRENT', '2026-09-06', -55.2, 'FUEL STATION 2231'],
  ['ACC-CURRENT', '2026-09-08', -13.99, 'NETFLIX.COM'],
  ['ACC-CURRENT', '2026-09-10', -72.41, 'ELECTRICITY BILL'],
  ['ACC-CURRENT', '2026-09-12', 25.0, 'PAYMENT FROM JANE DOE'],
  ['ACC-CURRENT', '2026-09-15', -38.9, 'MOBILE PHONE BILL'],
  ['ACC-CURRENT', '2026-09-18', -120.65, 'SUPERMARKET PURCHASE'],
  ['ACC-CURRENT', '2026-09-20', -45.0, 'GYM MEMBERSHIP'],
  ['ACC-CURRENT', '2026-09-22', -312.18, 'VISA CARD 4242 SETTLEMENT'],
  ['ACC-CURRENT', '2026-09-25', -60.0, 'ATM CASH WITHDRAWAL'],
  ['ACC-CURRENT', '2026-09-28', -29.95, 'HOME INSURANCE'],
  ['ACC-CURRENT', '2026-10-01', 2150.0, 'SALARY ACME SOLUTIONS LTD'],
  ['ACC-CURRENT', '2026-10-02', -650.0, 'RENT PAYMENT'],
  ['ACC-CURRENT', '2026-10-04', -91.12, 'GROCERY STORE PURCHASE'],
  ['ACC-CURRENT', '2026-10-05', -500.0, 'TRANSFER TO SAVINGS ACCOUNT'],
  ['ACC-CURRENT', '2026-10-08', -13.99, 'NETFLIX.COM'],
  ['ACC-CURRENT', '2026-10-10', -68.03, 'ELECTRICITY BILL'],
  ['ACC-CURRENT', '2026-10-14', -47.5, 'FUEL STATION 2231'],
  ['ACC-CURRENT', '2026-10-15', -38.9, 'MOBILE PHONE BILL'],
  ['ACC-SAVINGS', '2026-09-05', 500.0, 'TRANSFER FROM CURRENT ACCOUNT'],
  ['ACC-SAVINGS', '2026-09-30', 9.87, 'INTEREST PAYMENT'],
  ['ACC-SAVINGS', '2026-10-05', 500.0, 'TRANSFER FROM CURRENT ACCOUNT'],
  ['CARD-4242', '2026-09-04', -64.99, 'AMAZON EU SARL'],
  ['CARD-4242', '2026-09-11', -42.5, 'RESTAURANT'],
  ['CARD-4242', '2026-09-16', -18.7, 'PHARMACY'],
  ['CARD-4242', '2026-09-19', -186.0, 'DEPARTMENT STORE'],
  ['CARD-4242', '2026-09-22', 312.18, 'MONTHLY SETTLEMENT'],
  ['CARD-4242', '2026-10-03', -27.45, 'AMAZON EU SARL'],
];

// The broker's timeline, before it is put on the wire under the broker's own field names (appendBroker).
const BASE_BROKER = [
  { kind: 'cash', type: 'deposit', date: '2026-09-02', amount: 3000.0, text: 'Deposit from ES91 2100 0418 4502 0005 1332' },
  { kind: 'trade', type: 'buy', date: '2026-09-03', isin: 'IE00B4L5Y983', ticker: 'IWDA', name: 'iShares Core MSCI World UCITS ETF', assetClass: 'etf', units: 20, price: 98.45, fee: 1.0 },
  { kind: 'trade', type: 'buy', date: '2026-09-03', isin: 'IE00BK5BQT80', ticker: 'VWCE', name: 'Vanguard FTSE All-World UCITS ETF', assetClass: 'etf', units: 8, price: 131.2, fee: 1.0 },
  { kind: 'trade', type: 'buy', date: '2026-09-10', isin: 'US0378331005', ticker: 'AAPL', name: 'Apple Inc.', assetClass: 'stock', units: 3, price: 205.1, fee: 1.0 },
  { kind: 'trade', type: 'dividend', date: '2026-09-25', isin: 'US0378331005', ticker: 'AAPL', name: 'Apple Inc.', assetClass: 'stock', units: 3, gross: 0.78, tax: 0.12 },
  { kind: 'cash', type: 'interest', date: '2026-09-30', amount: 4.21, text: 'September interest' },
  { kind: 'trade', type: 'sell', date: '2026-10-07', isin: 'IE00B4L5Y983', ticker: 'IWDA', name: 'iShares Core MSCI World UCITS ETF', assetClass: 'etf', units: 5, price: 101.3, fee: 1.0, tax: 2.73 },
  { kind: 'cash', type: 'fee', date: '2026-10-08', amount: -1.5, text: 'Custody fee' },
  { kind: 'cash', type: 'withdrawal', date: '2026-10-12', amount: -200.0, text: 'Withdrawal to ES91 2100 0418 4502 0005 1332' },
];

const round2 = (n) => Math.round(n * 100) / 100;

function buildState() {
  const movements = {};
  for (const a of FAKE_ACCOUNTS) movements[a.id] = [];
  const counters = {};
  for (const [account, date, amount, concept] of BASE_MOVEMENTS) appendMovement(movements, counters, { account, date, amount, concept });
  const broker = [];
  for (const r of BASE_BROKER) appendBroker(broker, r);
  return { movements, counters, broker };
}

// Movement ids are stable and per account, like a bank's, and the running balance is recomputed in date order
// so the series always adds up (what Habeas's reconcile check expects of a real statement).
function appendMovement(movements, counters, { account, date, amount, concept, valueDate }) {
  const acc = FAKE_ACCOUNTS.find((a) => a.id === account);
  if (!acc) throw new Error('unknown account ' + account);
  counters[account] = (counters[account] || 0) + 1;
  const list = movements[account];
  list.push({ movId: `${account}-${String(counters[account]).padStart(4, '0')}`, bookingDate: date, valueDate: valueDate || date, amount: { value: round2(Number(amount)), currency: acc.currency }, concept });
  list.sort((x, y) => (x.bookingDate < y.bookingDate ? -1 : x.bookingDate > y.bookingDate ? 1 : x.movId < y.movId ? -1 : 1));
  let bal = acc.opening;
  for (const m of list) { bal = round2(bal + m.amount.value); m.balance = bal; }
}

function appendBroker(broker, r) {
  const id = 'BRK-' + String(broker.length + 1).padStart(4, '0');
  if (r.kind === 'trade') {
    const gross = r.gross != null ? round2(r.gross) : round2(r.units * r.price);
    const fee = round2(r.fee || 0);
    const tax = round2(r.tax || 0);
    // Net cash effect on the settlement account: a buy costs gross + fee; a sell or dividend pays gross − fee − tax.
    const net = r.type === 'buy' ? -round2(gross + fee) : round2(gross - fee - tax);
    broker.push({ eventId: id, eventType: 'TRADE', side: r.type, executedAt: r.date, instrument: { isin: r.isin, ticker: r.ticker, name: r.name, assetClass: r.assetClass }, quantity: r.units, unitPrice: r.price ?? null, gross, fee, tax, net, currency: 'EUR', cashAccount: FAKE_BROKER_ACCOUNT });
  } else {
    broker.push({ eventId: id, eventType: 'CASH', cashKind: r.type, executedAt: r.date, net: round2(r.amount), currency: 'EUR', text: r.text, cashAccount: FAKE_BROKER_ACCOUNT });
  }
  broker.sort((x, y) => (x.executedAt < y.executedAt ? -1 : x.executedAt > y.executedAt ? 1 : x.eventId < y.eventId ? -1 : 1));
}

// The SPA re-fetches a few times: the extension's hook lands asynchronously at document_start and may miss
// the first call — a real SPA fetches on navigation anyway.
const SPA = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fake Test Bank</title></head>
<body><h1>Fake Test Bank</h1><p id="t">loading</p><script>
var H={authorization:${JSON.stringify(TOKEN)}};
function go(){return fetch('/api/accounts',{headers:H}).then(function(r){return r.json()})
  .then(function(d){document.getElementById('t').textContent='loaded '+d.accounts.length;}).catch(function(){});}
go(); var n=0; var iv=setInterval(function(){ if(++n>8){clearInterval(iv);return;} go(); },500);
</script></body></html>`;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export function startMockBank({ port = 0 } = {}) {
  let state = buildState();
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const p = u.pathname;
      const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      try {
        if (p === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(SPA); }

        // Control API: the test drives the bank, so no session is needed (and none is ever replayed here).
        if (p === '/__control/reset' && req.method === 'POST') { state = buildState(); return json({ ok: true }); }
        if (p === '/__control/movement' && req.method === 'POST') { appendMovement(state.movements, state.counters, await readJson(req)); return json({ ok: true }); }
        if (p === '/__control/trade' && req.method === 'POST') { appendBroker(state.broker, { kind: 'trade', ...(await readJson(req)) }); return json({ ok: true }); }
        if (p === '/__control/state') return json({ movements: Object.fromEntries(Object.entries(state.movements).map(([k, v]) => [k, v.length])), broker: state.broker.length });

        // The API is gated like a real one: without the replayed session it answers 401.
        if (!/eyJ/.test(req.headers.authorization || '')) { res.writeHead(401); return res.end('no session'); }
        if (p === '/api/accounts') return json({ accounts: FAKE_ACCOUNTS.map(({ opening, ...a }) => a) });
        const mv = p.match(/^\/api\/accounts\/([^/]+)\/movements$/);
        if (mv) {
          const list = state.movements[decodeURIComponent(mv[1])];
          if (!list) return json({ error: 'not found' }, 404);
          // Newest first, like a bank's movements screen; page is 1-based.
          const page = Math.max(1, Number(u.searchParams.get('page')) || 1);
          const desc = list.slice().reverse();
          return json({ movements: desc.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), page, pageSize: PAGE_SIZE, total: desc.length });
        }
        if (p === '/api/broker/timeline') return json({ events: state.broker.slice().reverse() });
        res.writeHead(404); res.end();
      } catch (e) {
        json({ error: String(e.message || e) }, 400);
      }
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, origin: `http://localhost:${server.address().port}` }));
  });
}

// The source for the fake bank, written the way a published source is: two outputs, bank/card movements
// grouped by account (transaction@1) and the broker timeline (investment@2).
export function fakeBankSource(port) {
  return {
    id: 'fakebank-e2e',
    name: 'Fake Bank (E2E)',
    service: 'fakebank',
    trust: 'community',
    domain: 'localhost',
    currency: 'EUR',
    categories: ['banking', 'card', 'investment'],
    match: ['http://localhost/*'],
    openUrl: `http://localhost:${port}/`,
    auth: { tokenMatch: 'eyJ', replayHeaders: ['authorization'] },
    api: { host: `http://localhost:${port}` },
    streams: [
      {
        id: 'movements',
        name: 'Movements',
        schema: 'transaction@1',
        categories: ['banking', 'card'],
        api: {
          groups: { path: '/api/accounts', itemsPath: 'accounts', fields: { id: 'id', name: 'name', number: 'number', currency: 'currency' } },
          list: { path: '/api/accounts/{group.id}/movements', paging: 'page', pageParam: 'page', pageStart: 1, itemsPath: 'movements' },
        },
        fields: {
          internalId: 'movId',
          date: 'bookingDate',
          valueDate: 'valueDate',
          amount: 'amount.value',
          currency: 'amount.currency',
          description: 'concept',
          balanceAfter: 'balance',
          account: '{group.number}',
        },
      },
      {
        id: 'portfolio',
        name: 'Portfolio',
        schema: 'investment@2',
        categories: ['investment'],
        api: { list: { path: '/api/broker/timeline', paging: 'none', itemsPath: 'events' } },
        fields: {
          internalId: 'eventId',
          date: 'executedAt',
          recordType: 'eventType',
          side: 'side',
          kind: 'cashKind',
          isin: 'instrument.isin',
          ticker: 'instrument.ticker',
          instrumentName: 'instrument.name',
          assetClass: 'instrument.assetClass',
          units: 'quantity',
          price: 'unitPrice',
          grossAmount: 'gross',
          commission: 'fee',
          taxWithheld: 'tax',
          netAmount: 'net',
          amount: 'net',
          currency: 'currency',
          description: 'text',
          settlementAccount: 'cashAccount',
        },
      },
    ],
  };
}

// Run standalone to poke at it by hand: `node extension/test/e2e/mock-bank.mjs [port]`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { origin } = await startMockBank({ port: Number(process.argv[2]) || 0 });
  console.log(`Fake Test Bank at ${origin}`);
}
