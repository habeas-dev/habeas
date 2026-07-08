import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory } from '../src/runtime/inventory.js';
import { validateAdapter } from '../src/adapters/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = JSON.parse(readFileSync(join(here, '../../sources-repo/sources/wizink-movimientos-es.json'), 'utf8'));

// Statement dates are computed RELATIVE TO NOW so the maxAgeDays (90) cut is exercised deterministically
// regardless of when the suite runs: two within the window, one well beyond it.
const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const D30 = isoDaysAgo(30);   // reachable
const D60 = isoDaysAgo(60);   // reachable
const D120 = isoDaysAgo(120); // older than 90 days → must be dropped BEFORE any request (avoids the SMS)

// ---- synthetic fixtures (invented values; never the real capture) --------------------------------
const CSRF = '<input type="hidden" name="securityToken" value="TOK1234567890" />';
const GROUPS = "<a onclick=\"goToCardDetail('ACC1', 'CARD1', 'today');\" class=\"card-link\">"
  + "<div class=\"c-card__summary\">"
  + "<span class=\"card-product-name\"><span class=\"sr-only\">Nombre: </span>Test Card</span>"
  + "<span class=\"card-security-code\"><span class=\"sr-only\">N: </span> **** **** **** 1234 </span></div></a>";

function movRow(cat, date, loc, amount, responsive) {
  const amt = responsive
    ? `<span class="movement-amount hidden-xs hidden-sm hidden-md">${amount}</span><span class="movement-amount hidden-lg">${amount}</span>`
    : `<span class="movement-amount">${amount}</span>`;
  const location = loc ? `<span class="movement-location">${loc} </span>` : '';
  return `<li><div class="movement-item ${cat}"><div class="layout--left"><div class="layout--group">`
    + `<h4>${cat}</h4><span class="card-number-masked">*1234</span></div>`
    + `<div class="layout--group-2"><span class="movement-date">${date}</span>${location}</div></div>`
    + `<div class="layout--right">${amt}</div></div></li>`;
}
const wrap = (rows) => `<div class="card-movements"><ul>${rows.join('')}</ul></div>`;

// Current (unbilled) month: 3 movements, with responsive duplicate amount spans.
const CURRENT = wrap([
  movRow('alimentacion', '06 JUL', 'Test Shop A', '14,34 €', true),
  movRow('restaurante', '02 JUL', 'Test Rest B', '9,90 €', true),
  movRow('coche', '20 jun', 'Test Fuel C', '55,00 €', true),
]);
const DATES = `<script>callOperations('${D30}'); callOperations('${D60}'); callOperations('${D120}');</script>`;
const PAST = {
  [D30]: wrap([
    movRow('alimentacion', '18 may', 'Past Shop D', '21,00 €', false),
    movRow('cargos', '15 may', '', '3,50 €', false), // a charge → no location → empty description
  ]),
  [D60]: wrap([
    movRow('compras', '10 abr', 'Past Shop E', '1.234,56 €', false),
    movRow('servicios', '05 abr', 'Past Serv F', '12,00 €', false),
    movRow('otros', '02 abr', 'Past Shop G', '7,77 €', false),
  ]),
  // D120 is intentionally absent — but with maxAgeDays it must never be requested in the first place.
};

function mockNet() {
  const requested = []; // statementDates actually fetched (to prove the >90-day one is never asked for)
  const net = async (url, init) => {
    const u = new URL(url);
    const pn = u.searchParams.get('pagename') || '';
    const body = (init && init.body) || '';
    if (body.includes('{csrf}')) throw new Error('unfilled {csrf} in body');
    const reply = (text, ok = true, status = 200) => ({ ok, status, text: async () => text, json: async () => JSON.parse(text) });
    if (u.pathname === '/clientes/posicion-global') return reply(CSRF);
    if (pn.endsWith('NewGlobalPosition')) return reply(GROUPS);
    if (pn.endsWith('CardDetail/NewToday')) return reply(CURRENT);
    if (pn.endsWith('Today/ListExtracts')) return reply(DATES);
    if (pn.endsWith('ExtractOnScreenDetail')) {
      const d = (body.match(/statementDate=([0-9-]+)/) || [])[1];
      requested.push(d);
      if (PAST[d]) return reply(PAST[d]);
      return reply('<html>extra-auth required</html>', false, 500);
    }
    return reply('', false, 404);
  };
  net.requested = requested;
  return net;
}

test('wizink-movimientos source is valid (validateAdapter + JSON-schema-shaped)', () => {
  const v = validateAdapter(SRC);
  assert.ok(v.ok, 'validateAdapter errors: ' + v.errors.join('; '));
  assert.equal(SRC.schema, 'transaction@1');
  assert.deepEqual(SRC.categories, ['card']);
  assert.equal(SRC.api.list.maxAgeDays, 90, 'source caps document age at 90 days');
});

test('multi-period pipeline: current + reachable past statements; >90-day statement never requested', async () => {
  const logs = [];
  const net = mockNet();
  const docs = await listInventory(SRC, { byPath: {}, merged: {} }, net, { log: (m) => logs.push(m) });

  // current(3) + D30(2) + D60(3) = 8; D120 is filtered BEFORE fetching (no SMS trigger).
  assert.equal(docs.length, 8, 'expected 3 current + 2 + 3 past = 8 movements');

  for (const d of docs) {
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/, 'date normalized: ' + d.date);
    assert.equal(typeof d.record.amount, 'number', 'amount normalized: ' + JSON.stringify(d.record));
    assert.equal(typeof d.record.description, 'string');
    assert.equal(d.record.category, 'card');
    assert.equal(d.record.currency, 'EUR');
  }

  // First amount captured despite the responsive duplicate spans; Spanish thousands; empty-location charge.
  assert.ok(docs.some((d) => d.record.amount === 14.34), 'first responsive amount captured');
  assert.ok(docs.some((d) => d.record.amount === 1234.56), 'parsed 1.234,56 €');
  const charge = docs.find((d) => d.record.amount === 3.5);
  assert.equal(charge.record.description, '', 'a charge with no movement-location → empty description');

  // The KEY guarantee: the >90-day statement was never requested (that request is what fires the SMS).
  assert.ok(!net.requested.includes(D120), `>90-day statement ${D120} must not be requested; got ${JSON.stringify(net.requested)}`);
  assert.deepEqual([...net.requested].sort(), [D60, D30].sort(), 'only the two reachable statements were fetched');
  assert.ok(!docs.some((d) => d._raw._period === D120), '>90-day statement excluded from results');
  assert.ok(logs.some((m) => /older than 90d|90d/.test(m)), 'the age cut was logged, got: ' + JSON.stringify(logs));
});

test('per-period tagging carries the period into each movement', async () => {
  const docs = await listInventory(SRC, { byPath: {}, merged: {} }, mockNet());
  const periods = new Set(docs.map((d) => d._raw._period));
  assert.deepEqual([...periods].sort(), [D60, D30, 'current'].sort());
  assert.equal(docs.filter((d) => d._raw._period === 'current').length, 3);
});

test('internalId is synthesized, unique, and stable across re-runs (delivery ledger dedupes)', async () => {
  const run1 = await listInventory(SRC, { byPath: {}, merged: {} }, mockNet());
  const ids1 = run1.map((d) => d.internalId);
  assert.equal(new Set(ids1).size, ids1.length, 'internalIds are unique');
  assert.ok(ids1.every((id) => id.startsWith('ACC1|')), 'internalId composite keyed by account');

  const run2 = await listInventory(SRC, { byPath: {}, merged: {} }, mockNet());
  assert.deepEqual(new Set(run2.map((d) => d.internalId)), new Set(ids1), 'same input → same ids (stable)');
});

test('runtime synthesizes an internalId even when the source omits fields.internalId', async () => {
  const bare = JSON.parse(JSON.stringify(SRC));
  delete bare.fields.internalId;
  const docs = await listInventory(bare, { byPath: {}, merged: {} }, mockNet());
  assert.equal(docs.length, 8);
  assert.ok(docs.every((d) => d.internalId && d.internalId.startsWith('ACC1|')), 'fallback id built');
  assert.equal(new Set(docs.map((d) => d.internalId)).size, 8, 'fallback ids unique');
});
