import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirrors the group-months branch of runtime/inventory.js, to pin the boundary arithmetic.
function groupMonths(nowIso, maxAgeDays) {
  const now = new Date(nowIso);
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = now.getTime() - maxAgeDays * 86400000;
  const out = [];
  let y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  for (let i = 0; i < 36; i++) {
    const first = new Date(Date.UTC(y, m - 1, 1)), last = new Date(Date.UTC(y, m, 0));
    if (last.getTime() < cutoff) break;
    const from = new Date(Math.max(first.getTime(), cutoff));
    if (last.getTime() < todayStart) out.push({ period: `${y}-${String(m).padStart(2, '0')}`,
      fromDate: from.toISOString().slice(0, 10), toDate: last.toISOString().slice(0, 10) });
    m--; if (m < 1) { m = 12; y--; }
  }
  return out;
}

test('the month straddling the cutoff is asked for from the window, not from day 1', () => {
  // The exact case observed against ING: 2026-08-08, 89-day window, May straddles it.
  const months = groupMonths('2026-08-08T12:00:00Z', 89);
  const may = months.find((x) => x.period === '2026-05');
  assert.ok(may, 'May must still be offered — clamping keeps the month, it does not drop it');
  assert.equal(may.fromDate, '2026-05-11', 'must start at the window, not 2026-05-01');
  assert.equal(may.toDate, '2026-05-31');

  // Months fully inside are untouched.
  const june = months.find((x) => x.period === '2026-06');
  assert.equal(june.fromDate, '2026-06-01', 'a month fully inside the window keeps its first day');
});

test('89 days means the oldest valid day is today-89, counting today', () => {
  // 90 lands on 2026-05-10, one day outside a window that counts today — the off-by-one that
  // produced 401 CUSTOM_ERROR_003 on exactly the straddling month.
  assert.equal(groupMonths('2026-08-08T12:00:00Z', 89).find((x) => x.period === '2026-05').fromDate, '2026-05-11');
  assert.equal(groupMonths('2026-08-08T12:00:00Z', 90).find((x) => x.period === '2026-05').fromDate, '2026-05-10');
});

test('a month entirely outside the window is dropped, not clamped to nothing', () => {
  const months = groupMonths('2026-08-08T12:00:00Z', 89);
  assert.ok(!months.some((x) => x.period === '2026-04'), 'April is wholly outside and must not be requested');
});
