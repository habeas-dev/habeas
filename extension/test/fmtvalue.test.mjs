// Locale-aware value formatting for `{field:fmt}` field templates — a comma decimal in Spanish and a
// human duration ("6 meses" / "1 año"), so a deposit label reads like the bank's own UI. All values synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtValue, fillLocale } from '../src/runtime/inventory.js';

test('{locale} resolves to the browser locale (multi-market); {locale:lower} lowercases it', () => {
  const out = fillLocale('locale={locale}&l2={locale:lower}');
  assert.doesNotMatch(out, /\{locale/, 'no literal {locale} left to be sent to the API');
  const up = out.match(/locale=([^&]+)/)[1];
  const lo = out.match(/l2=([^&]+)/)[1];
  assert.match(up, /^[A-Za-z]{2}([-_][A-Za-z0-9]+)?$/, 'a BCP-47-ish locale');
  assert.equal(lo, up.toLowerCase());
});
test('fillLocale leaves a string without the token untouched', () => {
  assert.equal(fillLocale('customer_id={ctx.customer_id}'), 'customer_id={ctx.customer_id}');
});

test(':num formats a number in the given locale', () => {
  assert.equal(fmtValue('2.45', 'num', 'es-ES'), '2,45');
  assert.equal(fmtValue('2.45', 'num', 'en-US'), '2.45');
  assert.equal(fmtValue(1234.5, 'num', 'es-ES'), '1234,5'); // no grouping by default (a rate, not a total)
});

test(':pct multiplies a fraction by 100', () => {
  assert.equal(fmtValue('0.0245', 'pct', 'es-ES'), '2,45');
});

test(':duration renders {period,units} as a localized, auto-pluralized duration', () => {
  assert.equal(fmtValue({ period: 'MONTH', units: 6 }, 'duration', 'es-ES'), '6 meses');
  assert.equal(fmtValue({ period: 'YEAR', units: 1 }, 'duration', 'es-ES'), '1 año');
  assert.equal(fmtValue({ period: 'MONTHS', units: 12 }, 'duration', 'en-US'), '12 months');
  assert.equal(fmtValue({ unit: 'year', value: 2 }, 'duration', 'en-US'), '2 years'); // {unit,value} alias
  assert.equal(fmtValue({ period: 'x', units: 0 }, 'duration', 'es-ES'), ''); // unknown period → empty, not junk
});

test(':date normalizes to ISO YYYY-MM-DD', () => {
  assert.equal(fmtValue('2024-03-22T10:00:00Z', 'date', 'es-ES'), '2024-03-22');
});

test('null/empty is empty; unknown format returns the value', () => {
  assert.equal(fmtValue(null, 'num', 'es-ES'), '');
  assert.equal(fmtValue('hello', 'nope', 'es-ES'), 'hello');
});
