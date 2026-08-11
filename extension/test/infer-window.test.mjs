import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferWindow, inferThrottle, inferCapturePaths } from '../src/runtime/inferextras.js';

// A fixed "today" so these never depend on the clock. All dates below are synthetic.
const TODAY = Date.parse('2026-08-11T10:00:00Z');
const day = (n) => new Date(TODAY - n * 86400000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- window / maxAgeDays

test('a rolling date window is read off the request the SPA actually made', () => {
  // The site asked for the last ~90 days. That is the window it will enforce, and asking for one day
  // more is what made ING reject the month that straddles the boundary.
  const samples = [{ url: `https://api.example.test/tx?fromDate=${day(89)}&toDate=${day(0)}&limit=100` }];
  assert.deepEqual(inferWindow(samples, TODAY), { window: '89d', maxAgeDays: 89 });
});

test('the window is the widest span seen, not the first', () => {
  const samples = [
    { url: `https://api.example.test/tx?fromDate=${day(30)}&toDate=${day(0)}` },
    { url: `https://api.example.test/tx?fromDate=${day(89)}&toDate=${day(0)}` },
    { url: `https://api.example.test/tx?fromDate=${day(7)}&toDate=${day(0)}` },
  ];
  assert.equal(inferWindow(samples, TODAY).maxAgeDays, 89);
});

test('common date param spellings are recognised', () => {
  for (const k of ['fromDate', 'from_date', 'startDate', 'desde', 'fecha_desde', 'dateFrom', 'since']) {
    const got = inferWindow([{ url: `https://api.example.test/x?${k}=${day(89)}` }], TODAY);
    assert.equal(got?.maxAgeDays, 89, `${k} not recognised`);
  }
});

test('nothing is emitted when there is no date param, or the span is not a plausible window', () => {
  assert.equal(inferWindow([{ url: 'https://api.example.test/tx?limit=100&offset=0' }], TODAY), null);
  // A single day is a filter the user picked, not the service's retention window.
  assert.equal(inferWindow([{ url: `https://api.example.test/tx?fromDate=${day(1)}` }], TODAY), null);
  // Ten years back is an "everything" query, not a window.
  assert.equal(inferWindow([{ url: `https://api.example.test/tx?fromDate=${day(3650)}` }], TODAY), null);
});

test('a redacted date still works, because redactParam keeps short date-like values', () => {
  // This is what a shared handoff bundle looks like: ids replaced, dates preserved.
  const samples = [{ url: `https://api.example.test/v2/products/[id]/transactions?fromDate=${day(89)}&toDate=${day(0)}&limit=[v]` }];
  assert.equal(inferWindow(samples, TODAY).maxAgeDays, 89);
});

// ---------------------------------------------------------------- throttle

test('a throttle is inferred from the gaps between the SPA’s own calls to one host', () => {
  const at = (ms) => TODAY + ms;
  const samples = [
    { url: 'https://api.example.test/a', at: at(0) },
    { url: 'https://api.example.test/b', at: at(400) },
    { url: 'https://api.example.test/c', at: at(820) },
    { url: 'https://api.example.test/d', at: at(1210) },
  ];
  const t = inferThrottle(samples);
  // The site paced itself at ~400ms; copying that is what keeps a replay from looking unlike the SPA.
  assert.ok(t && t.minMs >= 300 && t.minMs <= 400, `unexpected minMs: ${JSON.stringify(t)}`);
  assert.ok(t.jitterMs > 0, 'a fixed interval is more machine-like than the site itself');
});

test('no throttle without timestamps, and none when the site fired everything at once', () => {
  assert.equal(inferThrottle([{ url: 'https://a.test/x' }, { url: 'https://a.test/y' }]), null);
  const burst = [0, 5, 9, 14].map((ms) => ({ url: 'https://a.test/x' + ms, at: TODAY + ms }));
  assert.equal(inferThrottle(burst), null, 'a burst means no pacing to copy');
});

// ---------------------------------------------------------------- capturePaths

test('a bearer that differs per path means the token is path-scoped', () => {
  const samples = [
    { url: 'https://api.test/dashboard/movements', reqHeaders: { authorization: 'Bearer AAA' } },
    { url: 'https://api.test/dashboard/statements', reqHeaders: { authorization: 'Bearer AAA' } },
    { url: 'https://api.test/profile', reqHeaders: { authorization: 'Bearer ZZZ' } },
  ];
  const got = inferCapturePaths(samples);
  assert.ok(got, 'two distinct bearers should be reported');
  assert.ok(got.some((p) => p.includes('/dashboard')), `expected a /dashboard scope, got ${JSON.stringify(got)}`);
});

test('one bearer everywhere needs no path scoping', () => {
  const samples = [
    { url: 'https://api.test/a', reqHeaders: { authorization: 'Bearer AAA' } },
    { url: 'https://api.test/b', reqHeaders: { authorization: 'Bearer AAA' } },
  ];
  assert.equal(inferCapturePaths(samples), null);
});

test('redacted headers yield nothing rather than a wrong guess', () => {
  // In a shared handoff the credential is replaced, so every request looks identical. Inventing a scope
  // from that would be worse than saying nothing.
  const samples = [
    { url: 'https://api.test/dashboard/x', reqHeaders: { authorization: '[cred]' } },
    { url: 'https://api.test/profile', reqHeaders: { authorization: '[cred]' } },
  ];
  assert.equal(inferCapturePaths(samples), null);
});

// ---------------------------------------------------------------- wiring into the drafter

test('a drafted source carries the window the site itself asked for', async () => {
  const { draftAdapterFromSamples } = await import('../src/runtime/infer.js');
  const from = new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10);
  const items = Array.from({ length: 4 }, (_, i) => ({
    id: `T${i}`, fecha: '2026-03-0' + (i + 1), importe: (i + 1) * 10, concepto: 'Compra ' + i,
  }));
  const samples = [{
    url: `https://api.example.test/v1/movements?fromDate=${from}&limit=50`,
    method: 'GET', status: 200, reqHeaders: { authorization: 'Bearer eyJhbGciOi.test.sig' },
    json: { movements: items },
  }];
  const r = draftAdapterFromSamples(samples, {});
  assert.ok(r.ok, `draft failed: ${r.reason || ''}`);
  assert.equal(r.draft.api.list.maxAgeDays, 89, 'the window should reach the draft, not just the inference');
  assert.equal(r.draft.api.list.window, '89d');
});

test('the window is counted in calendar days, whatever the time of day', () => {
  // 89 days + 12 hours is still an 89-day window. Rounding it to 90 is exactly the off-by-one that made
  // ING reject the month straddling its boundary.
  const noon = Date.parse('2026-08-11T12:30:00Z');
  const from = new Date(noon - 89 * 86400000).toISOString().slice(0, 10);
  assert.equal(inferWindow([{ url: `https://api.example.test/tx?fromDate=${from}` }], noon).maxAgeDays, 89);
  const dawn = Date.parse('2026-08-11T00:05:00Z');
  const from2 = new Date(dawn - 89 * 86400000).toISOString().slice(0, 10);
  assert.equal(inferWindow([{ url: `https://api.example.test/tx?fromDate=${from2}` }], dawn).maxAgeDays, 89);
});
