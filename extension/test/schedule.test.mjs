import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOccurrence, dayMatches, validateSpec, describeSchedule } from '../src/lib/schedule.js';

const iso = (d) => ((d.getDay() + 6) % 7) + 1;               // 1=Mon..7=Sun
const at = (occ, hh, mm) => { const d = new Date(occ); return d.getHours() === hh && d.getMinutes() === mm; };
const D = (y, mo, day, h = 0, mi = 0) => new Date(y, mo - 1, day, h, mi, 0, 0).getTime(); // local

test('daily: same day if the time is still ahead, else tomorrow', () => {
  const spec = { kind: 'daily', time: '09:00' };
  const a = new Date(nextOccurrence(spec, D(2026, 3, 10, 8, 0)));  // 08:00 → 09:00 today
  assert.equal(a.getDate(), 10); assert.ok(at(a, 9, 0));
  const b = new Date(nextOccurrence(spec, D(2026, 3, 10, 9, 0)));  // exactly 09:00 → strictly after → tomorrow
  assert.equal(b.getDate(), 11); assert.ok(at(b, 9, 0));
});

test('weekly: every Monday at 09:00', () => {
  const spec = { kind: 'weekly', weekdays: [1], time: '09:00' };
  for (const from of [D(2026, 3, 4, 12, 0), D(2026, 3, 9, 9, 1), D(2026, 6, 30, 0, 0)]) {
    const occ = new Date(nextOccurrence(spec, from));
    assert.equal(iso(occ), 1, 'is a Monday'); assert.ok(at(occ, 9, 0)); assert.ok(occ.getTime() > from);
  }
});

test('weekly: several weekdays picks the nearest', () => {
  const spec = { kind: 'weekly', weekdays: [1, 3, 5], time: '07:30' }; // Mon/Wed/Fri
  const occ = new Date(nextOccurrence(spec, D(2026, 3, 10, 8, 0))); // Tue 10th → next is Wed 11th
  assert.ok([1, 3, 5].includes(iso(occ))); assert.ok(at(occ, 7, 30)); assert.ok(occ.getTime() > D(2026, 3, 10, 8, 0));
});

test('monthly-day: day 5 at 15:30 (this month if ahead, else next)', () => {
  const spec = { kind: 'monthly-day', days: [5], time: '15:30' };
  const a = new Date(nextOccurrence(spec, D(2026, 3, 4, 0, 0)));  // before the 5th
  assert.equal(a.getDate(), 5); assert.equal(a.getMonth(), 2); assert.ok(at(a, 15, 30));
  const b = new Date(nextOccurrence(spec, D(2026, 3, 6, 0, 0)));  // after the 5th → next month
  assert.equal(b.getDate(), 5); assert.equal(b.getMonth(), 3);
});

test('monthly-weekday: the FIRST Monday of each month at 07:00', () => {
  const spec = { kind: 'monthly-weekday', nth: 1, weekday: 1, time: '07:00' };
  for (const from of [D(2026, 3, 15), D(2026, 12, 1), D(2027, 2, 20)]) {
    const occ = new Date(nextOccurrence(spec, from));
    assert.equal(iso(occ), 1, 'Monday'); assert.ok(occ.getDate() <= 7, 'first week'); assert.ok(at(occ, 7, 0));
    assert.ok(occ.getTime() > from);
  }
});

test('monthly-weekday: the LAST Friday of each month', () => {
  const spec = { kind: 'monthly-weekday', nth: -1, weekday: 5, time: '18:00' };
  const occ = new Date(nextOccurrence(spec, D(2026, 3, 1)));
  assert.equal(iso(occ), 5, 'Friday');
  const dim = new Date(occ.getFullYear(), occ.getMonth() + 1, 0).getDate();
  assert.ok(occ.getDate() + 7 > dim, 'no later Friday in the month');
});

test('monthly-businessday: the FIRST business day of each month at 08:30', () => {
  const spec = { kind: 'monthly-businessday', nth: 1, time: '08:30' };
  for (const from of [D(2026, 2, 15), D(2026, 8, 1), D(2026, 11, 10)]) {
    const occ = new Date(nextOccurrence(spec, from));
    assert.ok(iso(occ) >= 1 && iso(occ) <= 5, 'weekday'); assert.ok(at(occ, 8, 30));
    // no business day earlier in its month
    for (let day = 1; day < occ.getDate(); day++) { const w = ((new Date(occ.getFullYear(), occ.getMonth(), day).getDay() + 6) % 7) + 1; assert.ok(w > 5, `day ${day} must be a weekend`); }
  }
});

test('monthly-businessday: the LAST business day of each month', () => {
  const spec = { kind: 'monthly-businessday', nth: -1, time: '23:00' };
  const occ = new Date(nextOccurrence(spec, D(2026, 3, 1)));
  assert.ok(iso(occ) >= 1 && iso(occ) <= 5);
  const dim = new Date(occ.getFullYear(), occ.getMonth() + 1, 0).getDate();
  for (let day = occ.getDate() + 1; day <= dim; day++) { const w = ((new Date(occ.getFullYear(), occ.getMonth(), day).getDay() + 6) % 7) + 1; assert.ok(w > 5, `day ${day} after must be a weekend`); }
});

test('validateSpec catches bad specs; describeSchedule renders', () => {
  assert.ok(validateSpec({ kind: 'daily', time: '09:00' }).ok);
  assert.ok(!validateSpec({ kind: 'daily', time: '25:00' }).ok);
  assert.ok(!validateSpec({ kind: 'weekly', weekdays: [], time: '09:00' }).ok);
  assert.ok(!validateSpec({ kind: 'monthly-weekday', nth: 1, weekday: 9, time: '09:00' }).ok);
  assert.match(describeSchedule({ kind: 'weekly', weekdays: [1], time: '09:00' }), /Mon/);
  assert.match(describeSchedule({ kind: 'monthly-businessday', nth: 1, time: '08:30' }), /business day/);
});
