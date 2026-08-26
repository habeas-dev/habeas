// Does a run of bank movements add up?
//
// A statement is self-checking and almost nobody checks it: each movement carries the balance it left
// behind, so the amounts between any two movements must equal the difference between their balances.
// When they do not, either a movement is missing or an amount is wrong — and both failures are silent
// otherwise. Revolut delivered eighteen months of transactions where the amounts summed to −10.253,24
// against a real balance movement of 7,56, and nothing anywhere reported an error: the import
// succeeded, every record looked plausible, and the account was simply wrong by ten thousand euros.
//
// This is arithmetic on data already in hand. It needs no extra request, no permission and no capture,
// which is what makes it worth running on every source that reports a running balance.

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/**
 * Check a set of movements against the balances they claim to leave behind.
 *
 * Movements are compared within each (group, currency) run — a multi-currency account or several
 * pockets do NOT share a balance line, and summing across them would report a discrepancy that is
 * merely arithmetic on unrelated numbers.
 *
 * @param docs  [{ amount, balanceAfter, date, group?, currency? }]
 * @param tol   rounding tolerance, in the currency's own units
 * KNOWN LIMIT: the first movement of a run is unverifiable. Its own balance is what establishes the
 * opening figure, so a wrong first amount merely shifts the assumed opening by the same amount and the
 * arithmetic still closes. Catching that needs an opening balance from outside the run, which these
 * APIs do not provide. Every movement after the first is checked.
 *
 * @returns { ok, runs: [{ key, n, expected, actual, gap }], gap }  gap = worst absolute discrepancy
 */
export function checkBalanceContinuity(docs, tol = 0.01) {
  const runs = new Map();
  for (const d of docs || []) {
    if (!d) continue;
    const r = d.record || {};
    const amount = typeof d.amount === 'number' ? d.amount : (typeof r.amount === 'number' ? r.amount : null);
    if (amount == null) continue;   // no amount, nothing to add up
    // Balance is OPTIONAL. A movement can legitimately have none — a Revolut vault transfer carries the
    // vault's closing balance, so Habeas removes it rather than pollute the series with another account's
    // figure. Dropping such a movement entirely would be worse than the bug it came from: its amount is
    // real and must still be counted. It simply stops being a checkpoint.
    const balRaw = typeof d.balanceAfter === 'number' ? d.balanceAfter : (typeof r.balanceAfter === 'number' ? r.balanceAfter : null);
    const key = [d.group || r.group || '', d.currency || r.currency || ''].join('|');
    if (!runs.has(key)) runs.set(key, []);
    runs.get(key).push({ date: String(d.date || r.date || ''), amount, bal: balRaw });
  }

  const out = [];
  for (const [key, list] of runs) {
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    // Check between the first and last movements that DO carry a balance; everything in between counts
    // toward the sum whether it carries one or not.
    const first = list.findIndex((m) => m.bal != null);
    let last = -1;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].bal != null) { last = i; break; }
    if (first < 0 || last <= first) continue; // fewer than two checkpoints: no interval to verify
    const opening = list[first].bal - list[first].amount;
    const actual = list[last].bal - opening;
    const expected = list.slice(first, last + 1).reduce((s, m) => s + m.amount, 0);
    const gap = actual - expected;
    out.push({ key, n: last - first + 1, expected, actual, gap, ok: near(expected, actual, tol) });
  }
  const worst = out.reduce((w, r) => (Math.abs(r.gap) > Math.abs(w) ? r.gap : w), 0);
  return { ok: out.every((r) => r.ok), runs: out, gap: worst };
}
