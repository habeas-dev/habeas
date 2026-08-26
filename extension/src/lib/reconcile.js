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
    const amount = typeof d.amount === 'number' ? d.amount : (d.record && typeof d.record.amount === 'number' ? d.record.amount : null);
    const bal = typeof d.balanceAfter === 'number' ? d.balanceAfter : (d.record && typeof d.record.balanceAfter === 'number' ? d.record.balanceAfter : null);
    if (amount == null || bal == null) continue; // a movement without both tells us nothing either way
    const key = [d.group || (d.record && d.record.group) || '', d.currency || (d.record && d.record.currency) || ''].join('|');
    if (!runs.has(key)) runs.set(key, []);
    runs.get(key).push({ date: String(d.date || (d.record && d.record.date) || ''), amount, bal });
  }

  const out = [];
  for (const [key, list] of runs) {
    if (list.length < 2) continue; // one movement proves nothing: there is no interval to check
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    // Balance BEFORE the first movement, so the first one is included in the sum rather than assumed.
    const opening = list[0].bal - list[0].amount;
    const actual = list.at(-1).bal - opening;
    const expected = list.reduce((s, m) => s + m.amount, 0);
    const gap = actual - expected;
    out.push({ key, n: list.length, expected, actual, gap, ok: near(expected, actual, tol) });
  }
  const worst = out.reduce((w, r) => (Math.abs(r.gap) > Math.abs(w) ? r.gap : w), 0);
  return { ok: out.every((r) => r.ok), runs: out, gap: worst };
}
