// Which archived documents could a bank movement be?
//
// The question a person actually asks of their own records — "what was this 43,20 € charge?" — and the
// one an external consumer needs answered without ever being handed the documents. Cuéntamo holds the
// movement; it does not want Amazon's five thousand invoices, it wants to SHOW the right one when the
// user asks. So the matching happens here, the result is displayed by Habeas, and nothing crosses.
//
// Deliberately simple and explainable. A score a user cannot reason about is worse than no score: this
// is going to sit next to somebody's money, and "why is that the top match" must always have an answer.

const abs = (n) => Math.abs(Number(n) || 0);
const dayMs = 86400000;
const dayOf = (s) => { const t = Date.parse(String(s || '').slice(0, 10)); return Number.isFinite(t) ? t : null; };

// Amounts agree when they agree to the cent. Currency conversion is NOT attempted: a movement in EUR and
// a receipt in GBP may well be the same purchase, but guessing the rate would invent a match, and an
// invented match in a ledger is worse than a missing one.
const amountAgrees = (a, b, tol) => abs(abs(a) - abs(b)) <= tol;

/**
 * Rank archived documents as candidates for one bank movement.
 *
 * @param movement  { amount, date, currency?, counterparty? }
 * @param docs      [{ source, internalId, record }]  — records as the archive holds them
 * @param opts      { windowDays = 3, tolerance = 0.01, limit = 25 }
 * @returns [{ source, internalId, record, score, why: [reason…] }]  best first
 *
 * `why` carries the reasons in plain words, so the interface can show WHY something is proposed rather
 * than a number nobody can argue with.
 */
export function matchMovement(movement, docs, opts = {}) {
  const { windowDays = 3, tolerance = 0.01, limit = 25 } = opts;
  const mAmount = movement && movement.amount;
  const mDay = dayOf(movement && movement.date);
  if (mAmount == null || mDay == null) return [];
  const mCur = String((movement && movement.currency) || '').toUpperCase();
  const mParty = String((movement && movement.counterparty) || '').toLowerCase().trim();

  const out = [];
  for (const d of docs || []) {
    const r = (d && d.record) || {};
    const total = r.total != null ? r.total : r.amount;
    if (total == null) continue;                       // a document with no amount cannot be matched on one
    if (!amountAgrees(mAmount, total, tolerance)) continue;  // the amount is the entry ticket, not a bonus
    const dDay = dayOf(r.date);
    if (dDay == null) continue;
    const days = Math.round(abs(dDay - mDay) / dayMs);
    if (days > windowDays) continue;

    const why = ['amount'];
    // Same day is the strongest signal after the amount; a card charge usually settles within a few days,
    // so nearby dates still count, just less.
    let score = 60 + Math.max(0, 20 - days * 6);
    if (days === 0) why.push('same-day');
    else why.push(`${days}d`);

    const dCur = String(r.currency || '').toUpperCase();
    if (mCur && dCur && mCur === dCur) { score += 5; why.push('currency'); }
    // A movement's description usually carries the merchant, so a shared name is real corroboration —
    // but it is never required: plenty of banks write "COMPRA TARJETA 1234" and nothing else.
    const dParty = String(r.counterparty || (r.store && r.store.name) || r.storeName || '').toLowerCase().trim();
    if (mParty && dParty && (mParty.includes(dParty) || dParty.includes(mParty))) { score += 15; why.push('counterparty'); }

    out.push({ source: d.source, internalId: d.internalId, record: r, score, days, why });
  }

  // Best first; on a tie the nearer date wins, because it is the thing a person would look at next.
  out.sort((a, b) => (b.score - a.score) || (a.days - b.days));
  return out.slice(0, limit);
}
