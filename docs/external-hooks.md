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

Habeas injects a small bridge on every https page (and on `http://localhost` / `http://127.0.0.1` for local
development). You communicate with `window.postMessage`; the bridge relays to the extension and posts the reply
back to your page (same-origin only). Sinks must be **https** — except **loopback** hosts (`localhost`,
`*.localhost`, `127.x.x.x`), which may be plain `http://` (the browsers' *potentially trustworthy origin*
rule: the traffic never leaves the machine), so the whole flow works against a plain-http local dev server.
Origin-binding still applies: only a page served on localhost can propose a localhost sink.

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
const { grants, routes, sink } = await habeas('status');
// grants: [{ grantId, source, sinkOrigin }]  — the routes YOU established via propose/consent.
//         These are ACTIONABLE: each grantId feeds `collect` / `list-groups` / `revoke-grant`.
//         (the list-sources capability grant is not listed.)
// routes: [{ source, name, service, categories, trust, mode, enabled }]  — the full delivery config
//         pointed at your sink, INCLUDING routes the user wired by hand in Habeas's Settings (which
//         have no grant). mode: 'external' (via propose/consent) | 'auto' | 'manual'. Origin-bound
//         and PUBLIC metadata only — never accounts, documents or data. Use it to show the user
//         everything currently routed to you, not just what you set up through the consent flow.
// sink:   { registered, name? } — whether your origin is registered as a DESTINATION at all (via
//         register-sink OR a past proposal), even before any source is routed to it.
```

`grants` and `routes` answer different questions — "what can I trigger" vs "what is configured to reach
me". A source you connected appears in both; a source the user routed to you by hand appears only in
`routes` (no grantId, so you cannot `collect` it — the user drives it from Habeas).

## A′. Register as a destination (no source, no grant)

Sometimes you want to pair as a **destination first** and let the user choose sources afterwards, from
Habeas — instead of proposing a specific source. `register-sink` does exactly that: it registers your
origin-bound sink (with your delivery credential) and **grants you nothing** — no source, no pull
capability.

```js
const res = await habeas('register-sink', {
  sink: { type: 'http', url: 'https://tiquetera.app/ingest',   // MUST be your own origin's host
          headers: { 'x-pair-token': '…' } },                  // optional; sent with every delivery
});
// → { ok:true, status:'pending', requestId } — Habeas opened its consent screen ("be a destination?").
// → { ok:false, status:'denied', error:'origin-bound: …' } if the sink host ≠ your origin.
```

After the user approves, `status.sink.registered` becomes `true`. You cannot `collect` anything — you
only **receive** what the user routes to you (they wire sources → your sink in Habeas's Settings; those
appear in `status.routes` with no grant). Re-registering rotates the credential the same way a
re-proposal does (omit `headers` to keep the paired token). This is the push counterpart to `propose`:
`propose` = "let me fetch this source"; `register-sink` = "let me be a destination you send to".

**Connecting a second source?** Omit `sink.headers` in the new proposal: your origin's sink keeps the
pairing credential it already stores (you only ever saw the token once, so absence means "don't change
it"). Send `headers` again only to rotate the credential.

## A″. Records without files, and showing one on demand

Open to **any** consumer, not to a particular one. A ledger app, a spreadsheet, an accountant's portal —
anything that reconciles against records rather than storing documents.

The shape is always the same: you want the **list** of invoices, not the invoices. Something matching a
card charge needs Amazon's records and emphatically does not want five thousand PDFs — but when the user
asks *what was this charge?*, something has to be able to show the document.

Declare an **empty** artifact list on your sink and you receive records and no files:

```js
await habeas('register-sink', {
  sink: { type: 'http', url: 'https://cuentamo.app/ingest',
          accepts: { artifacts: [] } },   // [] = "these kinds, and there are none" → records only
});
```

Then, when the user wants to see one, ask Habeas to display it:

```js
await habeas('show-document', { source: 'amazon:', internalId: '405-1234567-1234567' });
// → { ok:true, status:'shown' }    Habeas opened its own viewer, in its own tab
// → { ok:false, status:'denied' }
```

`source` and `internalId` are the pair you were already given: `source` is the `source` field of the
multipart delivery (the `id:stream` store key), `internalId` is the record's own. `internalId` alone is
NOT a handle — it is unique within its source and stream, not globally.

**The document never crosses.** Nothing comes back but an acknowledgement: Habeas opens the file in its
own tab, and what appears there is between the extension and the person looking at it. That absence of a
return channel is what makes the capability safe to grant at all.

Two rules, both enforced:

- **You may only show what was routed to you.** The record must appear in the delivery ledger for your
  own sink. A consumer can display something it holds; it cannot go fishing through documents the user
  never sent it.
- **Every refusal is identical.** `denied` covers "not yours", "no such document", "no readable copy" and
  "you are not a paired integration" alike. If they read differently you could walk ids and learn what
  somebody owns without receiving a byte, and the refusal would become the leak.

## B. Request collection

```js
const res = await habeas('collect', { grantId });
// status: 'collecting' (a live session existed → running now)
//       | 'needs-login' (Habeas surfaced the source's login tab; the user authenticates, then it runs)
//       | 'debounced'   (rate-limited; try again shortly)
//       | 'denied'      (no such grant for your origin)
```

**Archive-only sync** — deliver what Habeas has already collected, without contacting the source
(no tab, no session, no login): pass `fromStore: true`. Only documents this route hasn't delivered
yet are sent (per-route dedupe as always); per-item files (PDFs) come along only when a site tab
happens to be open — records always deliver.

```js
await habeas('collect', { grantId, fromStore: true });          // → { ok:true, status:'done', fromStore:true, sent, found, rejected }
await habeas('collect', { grantId, group, fromStore: true });   // one account only
await habeas('collect', { grantId, fromStore: true, force: true }); // re-send the WHOLE archive, ignoring the ledger
// `found` = candidate documents in the archive; `sent` = positively acknowledged by your sink;
// `rejected` = your sink refused them (they stay undelivered and retry). found === 0 → the archive
// holds nothing new (collect from the source first). status:'error' + error on a delivery failure.
// `force` is the recovery path (e.g. records once marked delivered that your side dropped) — safe
// as long as your sink dedupes, which the acknowledgment protocol below assumes anyway.
```

### Per-record acknowledgment (recommended for http consumers)

Delivery marking is **positive-confirmation**: if your sink's JSON reply includes
`accepted: [id…]` (the canonical records' `id`s you actually incorporated — applied, queued for
review, or recognized as an already-known duplicate), Habeas marks ONLY those as delivered; the rest
stay pending and retry on the next sync. Optionally include `rejected: [id…]` for observability. A
reply without `accepted` keeps the old contract: HTTP 2xx confirms the whole batch. Never reply 2xx
while silently dropping records — without `accepted`, that marks them delivered and they will not be
re-sent.

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
// Once a live enumeration has succeeded, its result is CACHED and served on every later call —
// status 'ok' + `cached: true`, no bank contact, no tab. Pass `{ grantId, refresh: true }` to force
// a fresh in-session enumeration (which may surface a login). Each group also carries `label`, the
// exact `record.group` label delivered on records — use it to relate groups to data.
// With no cache and no live session, if the user already picked their accounts in Habeas's own
// "Accounts" picker, you get that saved selection ({ id, name } per group). If the user restricted
// the source to some accounts, cached and live listings are filtered to that selection too —
// excluded accounts are never revealed.
```

Then collect **one group at a time** by passing its `id`:

```js
await habeas('collect', { grantId, group: accountId }); // only that account's items are listed + delivered
```

`list-groups` is grant-gated and origin-bound like everything else; it enumerates **in the source's
own tab** (in-session) and returns **metadata only** — never the items, never to another origin. A
source with no groups returns `groups: []` (use plain `collect`). Omitting `group` in `collect`
delivers **all** groups.

## Revoking your own grant

A consumer may drop a grant it no longer wants (pure scope reduction — no consent screen). Origin-bound
like everything else: you can only revoke grants that belong to your origin. The user's source/sink
config in Habeas stays; only your origin's capability to trigger it goes away.

```js
await habeas('revoke-grant', { grantId });   // → { ok:true, status:'ok' } | { ok:false, status:'denied' }
```

Re-approving a proposal never stacks duplicates: there is at most ONE grant per (origin, source) — a
fresh approval replaces the previous grant.

## D. List enabled sources (discovery)

Ask which sources the user currently has **enabled**, so your app can offer the relevant ones instead
of hardcoding source ids. Consent-gated per origin: the first call opens Habeas's consent screen and
returns `pending`; retry once the user allows it (the approval is remembered, so later calls are silent).

```js
let res = await habeas('list-sources');
// first time   → { ok:true, status:'pending' }   (Habeas opened its consent screen; retry shortly)
// once allowed → { ok:true, status:'ok', sources: [
//   { source:'ing-es', name:'ING España', service:'ing', categories:['banking'], trust:'community' }, … ] }
```

It returns **public metadata only**: id, name, service, categories, and the `first-party` / `community`
trust label. Never accounts, documents, routes, sinks, or your data. The list is not origin-specific;
it is the same set the user sees in Habeas. Revocable anytime under **Settings → Site integrations**.

Full spec (schema, status semantics, polling helper, security model): [`list-sources.md`](list-sources.md).

## What Habeas will never do

- Send your users' data anywhere but your own origin.
- Store, transmit, or autofill credentials — login (incl. MFA) is always the user's, in their tab.
- Collect in the background with a stale/persisted session — no live session ⇒ interactive login.

Users can revoke any integration at any time under **Settings → Site integrations**.
