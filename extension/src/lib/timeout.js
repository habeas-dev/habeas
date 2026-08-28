// Bounded waiting. Nothing in a run may wait forever.
//
// This exists because of a failure that produced no error at all: a sync whose network calls simply never
// came back left the popup on "Listing…", wrote nothing to the activity log, fired no notification, and
// went four days before anyone noticed the archive had stopped growing. A run that FAILS is visible — it
// logs, it badges, it notifies. A run that hangs is invisible, which makes it the worse outcome.
//
// So: every call gets a deadline, and passing it is a real error naming what timed out.

// Generous enough for a slow statement over a bad link (a fetch settles on HEADERS, not on the whole
// body), short enough that a stuck run reports itself the same day. Sources may override per adapter.
export const DEFAULT_TIMEOUT_MS = 90000;

export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label || 'request'} timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'TimeoutError';
    this.timeout = true; // callers that classify errors (diagnostics, retry) can test this without parsing
  }
}

// Race `promise` against a deadline. `onTimeout` runs first, so a caller can cancel the real work
// (abort the request) rather than merely stop waiting for it.
export function withDeadline(promise, ms, label, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { if (onTimeout) onTimeout(); } catch (e) { /* cancelling is best-effort */ }
        reject(new TimeoutError(label, ms));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Wrap a fetcher so every call is bounded. Aborts the underlying request on the deadline (so the socket
// closes rather than lingering), and still forwards the caller's own signal — Stop must remain instant.
// Works for a page-context fetcher too, where the signal cannot cross into the tab: the race ends the
// wait even when nothing downstream honours the abort.
export function timedFetch(fetcher, ms, label) {
  const limit = ms > 0 ? ms : DEFAULT_TIMEOUT_MS;
  return (url, init = {}) => {
    const ctl = new AbortController();
    const outer = init.signal;
    if (outer) {
      if (outer.aborted) ctl.abort();
      else outer.addEventListener('abort', () => ctl.abort(), { once: true });
    }
    return withDeadline(fetcher(url, { ...init, signal: ctl.signal }), limit, label, () => ctl.abort());
  };
}
