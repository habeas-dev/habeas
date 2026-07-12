// Auto-sync scheduling policy — pure, unit-tested. The background worker fires a `mode:auto` route on
// the user's OWN login/navigation (never a background job while they're away). These helpers decide
// WHEN a route may run again, keeping that timing logic out of the side-effectful service worker.

// A route that ran is debounced for this long, so a chatty SPA (many `complete` navigations) doesn't
// re-list on every page. Only a COMPLETED run holds it — see retainAutoDebounce.
export const AUTO_DEBOUNCE_MS = 10 * 60 * 1000;

// May a route run now? `lastAt` is the epoch-ms of its last held run, or null/undefined when it never
// ran (or the debounce was released). Returns true while still inside the debounce window.
export function autoDebounced(lastAt, now, debounceMs = AUTO_DEBOUNCE_MS) {
  return lastAt != null && now - lastAt < debounceMs;
}

// After a run, KEEP the debounce (true) or release it so the next trigger retries immediately (false)?
// A transient/auth failure must release it: the auto-run can fire on the source's login page BEFORE the
// user authenticates (the CSRF prelude then 400s), or hit an anti-bot challenge, or find no captured
// session yet. Holding the debounce in those cases suppresses the retry that the user's real login would
// otherwise trigger — the bug where "it never tries again" after a first, premature failure. Only a
// completed run ('done' — whether it delivered documents or found nothing new) holds the 10-min window.
export function retainAutoDebounce(status) {
  return status === 'done';
}
