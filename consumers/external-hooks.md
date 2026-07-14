# External hooks — integrate your web app with Habeas

Any website can ask a user's Habeas extension to (A) **propose a workflow** (a `source → your-own
sink` route) and, once the user approves it in Habeas, (B) **request collection**. Two rules make
this safe, and they are non-negotiable:

- **Origin-bound sink** — the sink URL host **must equal your own origin's host**. Habeas will only
  ever send the user's data back to *you*, never to a third party. A proposal for any other host is
  rejected outright.
- **Explicit consent** — nothing is registered or run until the user clicks **Allow** on Habeas's
  own consent screen. `collect` on an already-granted route does not re-prompt, but can never widen
  scope (different source, different sink, extra categories) without a fresh proposal.

There is **no allowlist**: any origin may *propose*. Security comes from the two rules above, plus
the fact that collection always runs in a **dedicated tab** (foregrounded only when the user must
log in — Habeas never handles credentials), and is rate-limited and logged.

## Talking to the extension

Habeas injects a small bridge on every https page. You communicate with `window.postMessage`; the
bridge relays to the extension and posts the reply back to your page (same-origin only).

```js
function habeas(api, payload) {
  return new Promise((resolve) => {
    const id = 'h' + Math.random().toString(36).slice(2);
    function onMsg(ev) {
      const d = ev.data;
      if (ev.source !== window || !d || d.__habeasExt !== 'res' || d.id !== id) return;
      window.removeEventListener('message', onMsg);
      resolve(d.response);
    }
    window.addEventListener('message', onMsg);
    window.postMessage({ __habeasExt: 'req', id, api, payload }, location.origin);
  });
}
```

All replies are `{ ok, status, ... }` — the call never throws across the boundary. If Habeas isn't
installed, no reply arrives (time out how you like).

## A. Propose a workflow

```js
const res = await habeas('propose-workflow', {
  source: 'carrefour-es',                        // a source in the user's Habeas library
  sink:   { type: 'http', url: 'https://tiquetera.app/ingest',   // MUST be your own origin's host
            headers: { 'x-pair-token': '…' } },  // optional; sent with every delivery
  filter: { categories: ['grocery'] },           // optional; scope the data
});
// → { ok:true, status:'pending', requestId } — Habeas opened its consent screen.
// → { ok:false, status:'denied', error:'origin-bound: …' } if the sink host ≠ your origin.
```

`status:'pending'` means the consent screen is open. Poll **status** to learn the outcome:

```js
const { grants } = await habeas('status');   // only grants belonging to YOUR origin
// grants: [{ grantId, source, sinkOrigin }]
```

## B. Request collection

```js
const res = await habeas('collect', { grantId });
// status: 'collecting' (a live session existed → running now)
//       | 'needs-login' (Habeas opened the source's login tab; the user authenticates, then it runs)
//       | 'debounced'   (rate-limited; try again shortly)
//       | 'denied'      (no such grant for your origin)
```

Collection lists the source, delivers only **new** documents (Habeas dedupes per route), and POSTs
to your sink a `multipart/form-data` with: `records` (JSON manifest of normalized records — each
carries a `extra` object with the raw source fields), `files[]` (PDFs when available), `source`
(e.g. `carrefour-es`) and `service`. Re-running only ever sends what's new.

## C. List groups (accounts) — for sources that group their data

Some sources (a **bank** with several accounts, a broker with several portfolios) split their data
into **groups**. Before collecting, ask which groups exist so the user can pick:

```js
const res = await habeas('list-groups', { grantId });
// status: 'ok'           → res.groups: [{ id, name, iban, currency, … }]  (fields per the source; sensitive ones may be masked, e.g. "ES12 **** 3456")
//       | 'needs-login'  (Habeas opened the source's login tab; retry after the user authenticates)
//       | 'denied'       (no such grant for your origin)
```

Then collect **one group at a time** by passing its `id`:

```js
await habeas('collect', { grantId, group: accountId }); // only that account's items are listed + delivered
```

`list-groups` is grant-gated and origin-bound like everything else; it enumerates **in the source's
own tab** (in-session) and returns **metadata only** — never the items, never to another origin. A
source with no groups returns `groups: []` (use plain `collect`). Omitting `group` in `collect`
delivers **all** groups.

## What Habeas will never do

- Send your users' data anywhere but your own origin.
- Store, transmit, or autofill credentials — login (incl. MFA) is always the user's, in their tab.
- Collect in the background with a stale/persisted session — no live session ⇒ interactive login.

Users can revoke any integration at any time under **Settings → Site integrations**.
