# Integrating Habeas into your web app

Your web app can ask a user's **Habeas** browser extension to recover the user's own documents from a
service (a supermarket, a bank, an e-commerce site…) and deliver them **to your own backend**, in the
user's session, with the user's explicit consent. This lets you receive receipts, invoices, or
bank/card movements without ever handling the user's credentials or fighting anti-bot walls yourself.

This is the whole integration surface. It is small on purpose.

- **Talk to the extension** with `window.postMessage` (a bridge Habeas injects on every `https` page,
  and on `http://localhost` / `http://127.0.0.1` for local dev).
- **Receive data** at an HTTPS endpoint **on your own origin**, as `multipart/form-data`.

---

## Guarantees (and the two hard rules)

Habeas is built so a website can only ever route a user's data **back to itself**, and only after the
user says yes. Two rules are enforced by the extension and are non‑negotiable:

1. **Origin‑bound sink.** The delivery URL's host **must equal your page's origin host**. A proposal
   for any other host is rejected. A site can never route a user's data to a third party.
2. **Explicit consent.** Nothing is registered or run until the user clicks **Allow** on Habeas's own
   consent screen. An already‑approved route never re‑prompts, but can never *widen* scope (a different
   source, sink, or category set) without a fresh proposal.

There is **no allowlist** — any origin may *propose*. Security comes from the two rules above, plus:
collection always runs in a **dedicated tab** (foregrounded only when the user must log in — Habeas
never handles credentials, MFA is the user's), it is rate‑limited and logged, and the user can revoke
any integration at any time under **Settings → Site integrations**. Habeas will **never** collect in
the background with a stale session: no live session ⇒ interactive login.

---

## What you must provide

| You provide | Notes |
| --- | --- |
| An **HTTPS origin** for your web app | The bridge runs on `https://` pages (and `http://localhost` for dev). |
| An **HTTPS ingest endpoint on your own host** | e.g. `https://app.example.com/habeas/ingest`. Its host **must equal** your page's origin host. |
| (Optional) a **pairing token** | A header you supply in the proposal (e.g. `x-pair-token`) that Habeas sends with **every** delivery, so your endpoint can attribute the upload to a user/session. |
| (Optional) a **category filter** | e.g. `['grocery']` to receive only grocery receipts. |

You do **not** provide, and never receive: the user's credentials, cookies, or tokens for the source
service. Habeas keeps those in the user's session only.

---

## 1. Detect Habeas and open the channel

On every page it runs on, the bridge posts a one‑time readiness ping you can listen for:

```js
// { __habeasExt: 'ready', version: 1 }
window.addEventListener('message', (ev) => {
  if (ev.source === window && ev.data && ev.data.__habeasExt === 'ready') {
    // Habeas is installed on this page.
  }
});
```

A tiny request/response helper (copy‑paste). Every reply is `{ ok, status, … }` — the call never throws
across the boundary. If Habeas isn't installed, no reply arrives (time it out however you like):

```js
function habeas(api, payload) {
  return new Promise((resolve, reject) => {
    const id = 'h' + Math.random().toString(36).slice(2);
    const t = setTimeout(() => { window.removeEventListener('message', onMsg); reject(new Error('no-habeas')); }, 8000);
    function onMsg(ev) {
      const d = ev.data;
      if (ev.source !== window || !d || d.__habeasExt !== 'res' || d.id !== id) return;
      clearTimeout(t); window.removeEventListener('message', onMsg);
      resolve(d.response);
    }
    window.addEventListener('message', onMsg);
    window.postMessage({ __habeasExt: 'req', id, api, payload }, location.origin);
  });
}
```

There are **five** APIs: `list-sources`, `propose-workflow`, `status`, `list-groups`, `collect`.

---

## 2. Discover which sources the user has (`list-sources`)

Offer the user the sources they actually have enabled, instead of hard‑coding ids. Consent‑gated per
origin: the first call opens Habeas's consent screen and returns `pending`; retry once allowed (the
approval is remembered, so later calls are silent).

```js
let res = await habeas('list-sources');
// first time   → { ok:true, status:'pending' }               // consent screen opened; retry shortly
// once allowed → { ok:true, status:'ok', sources: [
//   { source:'ing-es', name:'ING España', service:'ing', categories:['banking'], trust:'community' },
//   { source:'carrefour-es', name:'Carrefour España', service:'carrefour', categories:['grocery','fuel'], trust:'first-party' },
// ] }
```

Returns **public metadata only** — `source` (id), `name`, `service`, `categories`, and the
`first-party` / `community` trust label. Never accounts, documents, routes, sinks, or your data.

## 3. Propose a workflow (`propose-workflow`)

Ask the user to approve a `source → your-endpoint` route. Opens Habeas's consent screen.

```js
const res = await habeas('propose-workflow', {
  source: 'carrefour-es',                                  // a source in the user's Habeas library
  sink: {
    type: 'http',
    url: 'https://app.example.com/habeas/ingest',          // MUST be your own origin's host
    headers: { 'x-pair-token': 'PER-USER-TOKEN' },         // optional; sent with every delivery
  },
  filter: { categories: ['grocery'] },                     // optional; scope the data
});
// → { ok:true,  status:'pending', requestId }             // consent screen is open
// → { ok:false, status:'denied', error:'origin-bound: …' } // sink host ≠ your origin
```

`status:'pending'` means the consent screen is open. Learn the outcome by polling **status**:

```js
const { grants } = await habeas('status');   // only grants belonging to YOUR origin
// grants: [{ grantId, source, sinkOrigin }]
```

Once a grant for your `source` appears, you have a `grantId` to collect with.

## 4. (Optional) List accounts/portfolios (`list-groups`)

Some sources (a **bank** with several accounts, a broker with several portfolios) split their data
into **groups**. Ask which exist so the user can choose:

```js
const res = await habeas('list-groups', { grantId });
// status:'ok'          → res.groups: [{ id, name, iban, currency, … }]  // fields per source; sensitive ones masked, e.g. "ES12 **** 3456"
//       'needs-login'  → Habeas opened the source's login tab; retry after the user authenticates
//       'denied'       → no such grant for your origin
```

Metadata only — enumerated **in the source's own tab**, never the items, never to another origin. A
source with no groups returns `groups: []`.

## 5. Collect (`collect`)

Run the route: Habeas lists the source, delivers only **new** documents (deduped per route), and POSTs
them to your endpoint.

```js
const res = await habeas('collect', { grantId });
// status: 'collecting'  → a live session existed; running now
//         'needs-login' → Habeas opened the source's login tab; it runs once the user authenticates
//         'debounced'   → rate-limited; try again shortly
//         'denied'      → no such grant for your origin
```

Collect one account at a time by passing its `group` id (omit `group` to deliver **all** groups):

```js
await habeas('collect', { grantId, group: accountId });
```

Re‑running only ever sends what's new.

---

## Your ingest endpoint — the HTTP contract

Each collection run POSTs to your `sink.url` a **`multipart/form-data`** body:

| Field | Type | What it is |
| --- | --- | --- |
| `source` | text | The source id, e.g. `carrefour-es`. |
| `service` | text | The service, e.g. `carrefour`. |
| `records` | text (JSON) | The manifest: an array of **normalized records** (see below). |
| `files[]` | file(s) | The documents themselves (PDFs, when the source has one). Each filename is `<internalId>.<ext>`. |

Plus any **headers you supplied** in the proposal's `sink.headers` (e.g. your `x-pair-token`), sent on
every delivery.

Your endpoint should:

- Authenticate the request with your pairing token (and CORS/CSRF as usual — the request is a
  cross‑origin `fetch` from the extension, not from your page).
- Return a **2xx** status. A non‑2xx response is treated as a failed delivery and the documents are
  **not** marked delivered, so the next `collect` retries them. Returning JSON (e.g.
  `{ "written": 12 }`) is fine but optional.
- Be idempotent: match on `record.internalId` (stable per document) to avoid duplicates on retries.

### The normalized record shape

`records` is a JSON array. Each record's shape depends on the source's schema (`receipt`, `invoice`,
`transaction`, `investment`), but the common, dependable fields are:

```jsonc
{
  "internalId": "abc123",         // stable, unique per document within the source — your dedup key
  "date": "2026-06-14",           // ISO date (may be date-only)
  "total": 48.20,                 // amount as a number (see currency)
  "currency": "EUR",
  "category": "grocery",          // Habeas category (grocery, fuel, banking, card, …)
  "type": "purchase",             // source-specific type
  "source": "carrefour-es",
  "store": { "name": "…", "address": "…" },  // receipts/invoices (issuer/counterparty vary by schema)
  "extra": { /* every raw source field the schema didn't consume — nothing captured is lost */ }
}
```

`extra` always carries the raw source fields, so you can read anything the normalized shape didn't
surface. A file may be **absent** for a given record (e.g. a bank movement is data‑only, or an old
receipt whose PDF the service no longer serves) — the record is still delivered.

> Want one **uniform** shape regardless of source? Ask for it in your integration and Habeas can
> deliver a canonical record `{ id, date, amount, currency, direction, description, counterparty,
> category, account, source, extra }` (see the full [`../consumers/cuentamo-data-contract.md`]).

---

## End‑to‑end example

```js
async function connectCarrefour() {
  // 1) (optional) discover what the user has
  let list = await habeas('list-sources');
  if (list.status === 'pending') { /* tell the user to Allow, then retry */ return; }

  // 2) propose the route to your own ingest endpoint
  const prop = await habeas('propose-workflow', {
    source: 'carrefour-es',
    sink: { type: 'http', url: 'https://app.example.com/habeas/ingest', headers: { 'x-pair-token': USER_TOKEN } },
    filter: { categories: ['grocery'] },
  });
  if (!prop.ok) throw new Error(prop.error);

  // 3) wait for the user to approve (poll status)
  let grantId;
  for (let i = 0; i < 60 && !grantId; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await habeas('status');
    const g = (s.grants || []).find((x) => x.source === 'carrefour-es');
    if (g) grantId = g.grantId;
  }
  if (!grantId) return; // user didn't approve

  // 4) collect (Habeas opens the login tab if there's no live session)
  await habeas('collect', { grantId });
  // → your https://app.example.com/habeas/ingest receives the multipart POST(s).
}
```

---

## Local development

The bridge also runs on `http://localhost` and `http://127.0.0.1`, so you can call `list-sources` and
wire up the flow locally. **But** `propose-workflow` / `collect` still require an **HTTPS** sink URL
(the origin‑bound rule), so your ingest endpoint must be served over HTTPS to actually receive data —
even in development (a tunnel such as an https dev proxy works).

## Revocation & UX

- Grants are per origin, one route each, and revocable anytime under **Settings → Site integrations**.
- `status` only ever returns **your** origin's grants — never other sites'.
- Design for the async, human‑in‑the‑loop nature: a `pending` means "the user is deciding", a
  `needs-login` means "the user is authenticating in their own tab". Poll, don't block.

## What Habeas will never do

- Send your users' data anywhere but **your own origin**.
- Store, transmit, or autofill **credentials** — login (incl. MFA) is always the user's, in their tab.
- Collect in the **background** with a stale/persisted session — no live session ⇒ interactive login.

---

## See also

- [`../consumers/external-hooks.md`](../consumers/external-hooks.md) — the same protocol, from the extension's side.
- [`../consumers/list-sources.md`](../consumers/list-sources.md) — the `list-sources` discovery hook in depth.
- [`../consumers/cuentamo-data-contract.md`](../consumers/cuentamo-data-contract.md) — the full normalized/canonical record contract.
