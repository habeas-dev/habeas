# Authoring a Habeas source (advanced: proxy capture + AI)

This is the **advanced** path from [ADDING-SOURCES.md](ADDING-SOURCES.md): capture a service's traffic
yourself with [mitmproxy](https://mitmproxy.org/), then work with **any AI agent** that can read your
capture *and this repository* to hand-author a source for **any service, no matter how complex** —
multi-account banks, cross-domain APIs, async document jobs, WebSocket feeds, HTML-only sites. You
verify the source **offline** against your own capture before submitting a PR.

> **Who this is for.** Technical contributors who want to add a source properly and share it. If you
> just want a source for yourself, or you'd rather the team finish it, use the *local* or *assisted*
> paths instead — no proxy, no code. See [ADDING-SOURCES.md](ADDING-SOURCES.md).
>
> **mitmproxy is your tool.** You install and run it yourself. Habeas does not ship, bundle, or
> configure it, and you should not add any proxy tooling to this repo.

A source is **pure data** — a JSON object the runtime interprets. You never write code. Your job is
to describe, declaratively: *which requests the site's app makes, and how to turn the responses into
records and documents.*

---

## The workflow at a glance

```
1. Capture      run mitmproxy, browse the service signed-in → a set of request/response flows
2. Understand   find the API calls that list your data + fetch each document
3. Author       with an AI + this repo, write the source object (fields below)
4. Verify       run the offline replay harness against your capture until every output PASSES
5. Submit       open a PR to habeas-dev/sources
```

Steps 3–4 are a loop: the harness tells you exactly what doesn't match the captured requests, you fix
the source, repeat. **Do not test live round-trip after round-trip** — the harness verifies everything
offline against the capture first.

---

## 1. Capture with mitmproxy

**Install** (pick one):

```bash
pipx install mitmproxy         # recommended (isolated)
# or: pip install --user mitmproxy
# or: brew install mitmproxy   # macOS
```

**Trust its CA** so HTTPS is readable — start `mitmproxy` once, then visit **http://mitm.it** in the
browser you'll capture with and install the certificate for your OS/browser (follow its instructions).
On Linux you can trust it for NSS-based browsers with `certutil` against `~/.pki/nssdb`.

**Point your browser at the proxy** (default `127.0.0.1:8080`). Use a dedicated profile or a
proxy-switcher extension so you don't proxy everything. Then:

```bash
mitmweb            # a web UI at http://127.0.0.1:8081, easiest to browse flows
# or: mitmproxy    # terminal UI
# or: mitmdump -w capture.flows   # headless, saves a flow file
```

**Record the session:** with capture running, **sign in to the service and navigate to every screen
whose data you want** — the list of transactions/receipts/orders, *each* document you want to
download, every account/product, and any "inactive/archived" views. The app's XHR/fetch calls are
what you'll replay. Capture generously; you can't author a request the app never made.

**Filter to the service** in mitmproxy (e.g. `~d example.com` or the API host) so the flows are just
the relevant calls.

### Security — read this before you share anything

- **A capture holds your real personal data.** Never commit it, never paste it into a PR, never put it
  in the repo. Keep it outside the tree.
- When you (or your AI) create examples, fixtures, or tests, **synthesize every value from scratch** —
  never reuse a real amount, id, date, name, or token from the capture.
- The bundle you feed the harness (below) can keep real *query-param* values (needed to compare
  requests) but should keep real *response* payloads out of anything you publish.

---

## 2. Understand what you captured

Look at the flows and identify:

- **Auth** — what makes the API calls authenticate? A `Authorization: Bearer eyJ…` header? Session
  cookies? A token the SPA reads from `localStorage`? Which request paths carry it?
- **The list call(s)** — the request that returns your items (transactions, receipts, orders,
  deposits…). Note its URL, method, query params, and where the array of items lives in the JSON
  response (the "items path").
- **Pagination** — does the list page by `offset`, `page`, a `cursor`, a date window, or not at all?
- **Grouping** — is the data per-account (a bank with several cards/accounts)? Then there's usually an
  "accounts" call, and the list call is repeated per account.
- **Documents** — the request that fetches each PDF/statement. Is it a direct URL? An absolute link on
  the item? A two-step "generate then download" job? Base64 inside a JSON response?
- **Cross-domain** — is the login site on one domain and the API on another (e.g. `raisin.com` →
  `api2.weltsparen.de`)? Note both.

The reference adapter [`extension/src/adapters/carrefour-es.js`](../extension/src/adapters/carrefour-es.js)
and the published sources in `habeas-dev/sources` are worked examples — read a few close to your case.

---

## 3. Author the source — the adapter reference

A source is one object. Here is the complete field surface. `validate.js` enforces the **bold-required**
subset and a security guard; the rest is interpreted by the runtime (`extension/src/runtime/inventory.js`)
and only checked by the offline harness (step 4). **There is no JSON-Schema file — `validate.js` +
this document are the authority.**

### 3.1 Identity & trust

| field | meaning |
|---|---|
| **`id`** | kebab-case, unique (`^[a-z0-9]+(-[a-z0-9]+)*$`), e.g. `raisin-es`. |
| **`name`** | human name shown in the UI. |
| **`service`** | short service label (used in filenames/records). |
| `domain` | the service's primary domain; anchors the same-domain guard (defaults to `api.host`). |
| **`match[]`** | URL match patterns for the login site(s), e.g. `["https://www.carrefour.es/*"]`. |
| **`categories[]`** | one or more from the [category list](categories.md) — see §3.7. |
| `categorize` | `{ default, map:{ apiValue: category } }` — classify each item by a field value. |
| `version` | `YYYY-MM-DD[.N]` (compared lexicographically; the marketplace offers updates). |
| `minVersion` | minimum extension version the source needs (gate features it relies on). |
| `trust` | `first-party` (audited) or `community`; imported sources are forced to `community`. |
| `crossDomainHosts[]` | domains other than `domain` the source may touch — forces a consent screen. |
| `throttle` | `{ minMs, jitterMs }` — space out requests to be polite. |

**Security guard (enforced).** Every host the source touches — `api.host`, `api.pdf.host`, all
`match[]`, etc. — must share ONE registrable domain (eTLD+1) with `domain`, **unless** listed in
`crossDomainHosts`. A captured session can only ever be replayed to the same service it came from.

### 3.2 `auth` — replaying the session

| field | meaning |
|---|---|
| `auth.mode` | `bearer` (a token) or `cookie` (session cookies carry auth). |
| `auth.tokenMatch` | regex a captured header value must match to be treated as the token (default `eyJ` — a JWT). |
| `auth.tokenHeader` | the header the token lives in (default `authorization`). |
| **`auth.replayHeaders[]`** | headers to replay alongside the token (may be `[]` for cookie auth). |
| `auth.capturePaths[]` | only capture the token from requests to these path prefixes (keeps capture off the login flow). |
| `auth.ignorePaths[]` | never capture from these paths. |
| `auth.tokenFromStorage` | `{ key, field?, scheme?, header? }` — read the bearer FRESH from `localStorage[key]` on every request (with no `field`, auto-detects the access token in a token object). |
| `auth.context[]` | `[{ name, from:'url', match:'regex-with-one-(group)' }]` — capture a value (a DNI, a customerId) from observed URLs → usable as `{ctx.name}`. |
| `auth.cookies` | `false` to send the bearer WITHOUT cookies (some gateways reject a bearer + a stale session cookie). |

### 3.3 `api` — where the data lives

`api.host` (**https** required, or loopback for testing). Then one of the list shapes below, plus
optional `api.groups` (accounts) and `api.pdf`/`api.document`/`api.detail` (documents).

**`api.list`** — enumerate items:

| field | meaning |
|---|---|
| **`path`** or **`paths[]`** | the list URL(s). `paths[]` fetches several endpoints and **merges** them (e.g. deposits from `/dashboard/active` **and** `/dashboard/inactive`). |
| `params` | query params (values may use templates, §3.8). |
| `paging` | `offsets` \| `offset` \| `page` \| `cursor` \| `none` \| `years` \| `synthetic` (see §3.6). |
| **`itemsPath`** | where the item array is in the response: a dotted path (`data.results`), `"$"` (the response IS the array), an **array selector** `key[field=value].sub`, or an array of candidate paths (first non-empty wins). |
| `keep` | `{ field, values[] \| present:true \| prefix }` — keep only matching items (whitelist / has-field / id-prefix routing). |
| `paramSets[]` | replay several disjoint filter-views and union them (e.g. status tabs). |
| `window` / `range` | `{ from, to, format }` — a date window stamped into params/body. |
| `maxAgeDays` | drop items older than N days. |
| `headers` / `body` / `contentType` / `method` / `referer` | for POST lists / per-request headers (values may template `{group.*}`). |
| paging knobs | `offsetsPath, offsetParam, offsetStep, pageParam, pageStart, nextPath, cursorFromItem, cursorParam, nextIsUrl, maxPages, initialOffsets, stopPath/stopValue` — as the strategy needs (§3.6). |

**`api.groups`** — per-account sources (a bank). Enumerated first; the list runs once per group:

| field | meaning |
|---|---|
| `path` or `paths[]` | the accounts endpoint(s). `paths[]` merges (active + inactive products). |
| `params`, `itemsPath`, `keep`, `host`, `from:'html'`, `headers`, `body`, `method`, `referer` | as `api.list`. |
| `fields` | map each account: `{ id, name?, iban?, mask?, type?, currency?, … }`. `id` is required to be listable; `name` drives the human label (with a template you can compose e.g. `"Cuenta {product.bank.name}"`). |
| `derive` | `{ from, trim, slice:[a,b] }` — post-process a derived field. |

The current group is available in the list path/params/headers as `{group.field}`.

**`api.pdf`** (and `api.document` / `api.detail`) — fetch each document:

| field | meaning |
|---|---|
| `path` | document URL template (`/tickets/{internalId}/pdf`, `{field.path}`, `{group.*}`, `{ctx.*}`, `{csrf}`). |
| `params` | query on the document fetch (e.g. `?preview=true`). |
| `urlField` | the raw item already carries an **absolute** URL to the file (guarded by the same-domain check). |
| `base64Field` | the PDF is base64 **inside** a JSON response field; `mime` sets the type. |
| `resolve` | `{ path, linkMatch, headers }` — two-step: fetch a page, extract the real link. |
| `poll` | `{ path, statePath, readyValue, urlField, tries, delayMs }` — async signed-URL generation. |
| `job` | `{ start:{path,body,idField}, status:{path,statePath,readyValue,tries}, download:{path} }` — async export by job id (CSV/Excel). |
| `headers` / `method` / `body` / `referer` / `ext` / `host` | per-document specifics. |

`api.detail` fetches richer per-item data (`detail.as = render|html|invoice`, `detail.from:'list'` for
no extra request, `detail.fields`/`detail.template` for HTML). `api.csrf` `{path,match,host,…}` grabs a
CSRF token first. Exotic transports: `api.ws` (WebSocket, Trade Republic) and `api.mtop` (Alibaba).

### 3.4 `fields` — mapping a raw item to a record

Map response fields to the record shape. **`fields.internalId`** and **`fields.date`** are required.
A field value is a **dotted path** (`price.total`), an array-selector, or a **template** with
surrounding text (interpolated to a string, `{group.*}` supported) — a lone `{path}` preserves type.

Which other fields you set depends on the **schema** (§3.5). Set `keepRaw:true` to carry every unmapped
raw field into `record.extra` (nothing captured is lost).

### 3.5 `schema` — the record shape

`schema` is `name@version` (`^[a-z_]+@\d+$`). Implemented shapes and the `fields.*` they read
(`extension/src/sinks/format.js`):

| schema | record | reads `fields.*` |
|---|---|---|
| `receipt@1` (default) | `{internalId,date,total,currency,category,store:{name,address},source,type}` | `internalId,date,total,storeName,storeAddress,type,number` |
| `invoice` | `{…total,issuer:{name,address},number,description?}` | `issuer/issuerAddress`, `number`, `description` |
| `transaction@1` | `{…amount,description,counterparty,direction,+location/card/isin/account/valueDate/balanceAfter}` | `amount/total, description, counterparty, direction, …` |
| `investment@1` | `{…instrument,isin,units,price,amount,operation}` | `instrument,isin,units,price,operation` |
| `investment@2` | discriminated `trade` / `cash` (settlement breakdown, `instrument:{isin,ticker,mic,name}`) | many aliases — see `buildInvestment2` |

`amount`/`total` are parsed (symbols/ISO/`,`/`.` handled); currency resolves embedded → per-doc →
`adapter.currency` → EUR. See [cuentamo-data-contract.md](../consumers/cuentamo-data-contract.md) for
finance field semantics.

### 3.6 Paging strategies

| `paging` | how |
|---|---|
| `none` | one request. |
| `offset` | `offsetParam` + `offsetStep`/`count`, until an empty page. |
| `offsets` | cursor-map: seed `initialOffsets`, merge `get(resp, offsetsPath)` each page. |
| `page` | `pageParam` from `pageStart`, `stopAfterEmpty` tolerance, `maxPages`. |
| `cursor` | `cursorParam` + `nextPath` or `cursorFromItem` (time-windowed); `stopPath/stopValue` marks an SCA/OTP boundary (keep the page, stop). |
| `years` | scan a bounded window of years (`years:{param,format:"year-{y}",back,…}`). |
| `synthetic` | documents that aren't listed by an API — they exist once per period/account: `synthetic.each = months \| group \| group-months`; the document comes from `api.pdf`. |
| (`paths[]`) | not a pager: merge several endpoints (any base paging). |
| (`paramSets[]`) | not a pager: union disjoint filter-views. |
| (`periods`) | WiZink-style: assemble from several period fetches sharing an HTML parser. |

### 3.7 Categories

`categories[]` must use values from [categories.md](categories.md) / `validate.js CATEGORIES`:
`grocery, fuel, sports, fashion, electronics, home, diy, pharmacy, restaurant, marketplace, travel,
entertainment, retail, energy, water, telecom, utility, tolls, transport, insurance, subscription,
domains, education, healthcare, government, card, cash, banking, investment, pension, crypto, loan,
other`. Sinks filter by category, so pick the honest one; use `categorize` to classify per-item.

### 3.8 Templating tokens

Usable in paths, params, bodies, headers, and field values:

| token | resolves to |
|---|---|
| `{ctx.name}` | a captured context value (`auth.context`), e.g. a customerId. |
| `{group.field}` | the current account's field (grouped sources). |
| `{internalId}` | the item's internal id (document fetch). |
| `{field.path}` | any dotted path on the raw item (document fetch / field templates). |
| `{csrf}` | the CSRF token from `api.csrf`. |
| `{today} {monthStart} {monthEnd} {daysAgo:N}` | computed calendar dates; add `:YYYY-MM-DD`-style format. |
| `{date:DD/MM/YYYY}` | reformat a date value. |
| `{paramName}` | a value from the current request params. |

### 3.9 Multi-output sources (streams × formats)

A service that exposes several distinct data sets (a bank: movements **and** monthly statements) uses
`streams[]`. Each stream has its own `api.list`/`schema`/`fields`; per stream, `formats[]` are
artifacts sharing the stream's items (a statement as PDF **or** Excel — overriding only `api.pdf`). A
selectable **output** is a `(stream, format)` pair. Validation runs **per output**. When a source has
`streams`, put shared bits at the top level and stream-specific bits under each stream. See
`extension/src/lib/outputs.js` and a multi-stream published source (e.g. WiZink, ING, Raisin).

### 3.10 Normalization (optional)

`normalize.counterparty {from, re}` extracts a clean counterparty from free text; `normalize.map`
maps a raw enum to a stable value; `canonicalize(record)` produces a uniform cross-schema shape for
consumers (delivered only when a sink opts in). See `extension/src/lib/normalize.js`.

---

## 4. Verify offline with the replay harness

This is the gate. It runs the **real runtime** against your capture and tells you precisely what
doesn't match a request the app actually made.

Turn your capture into a **bundle** — a JSON file `{ "samples": [ … ], "assets": [ … ] }` where each
sample is `{ url, method, reqBody?, reqHeaders?, json }` (the response body under `json`, with its
shape intact; query-param values kept so requests compare). Your AI can produce this directly from the
mitmproxy flows. (Binary PDF fetches go in `assets[]` as `{url, method, status}`.) A recording exported
by the extension's record mode is already in this shape.

```bash
node scripts/replay-capture.mjs <bundle.json> <your-source.json>
```

It prints, per output: `PASS`/`FAIL`, `listed=N`, `doc=ok|FAIL`, then:

- **`✗ unresolved template in GET … — param customer_id="{ctx.customer_id}"`** — a `{ctx.*}/{group.*}`
  didn't resolve (it would be sent literally and rejected). Fix the field/param.
- **`✗ … does not match the SPA — missing query params: …`** — your request omits a param the app sent.
- **`✗ no captured GET request for …`** — you're calling a path the capture doesn't contain (wrong path,
  or you need to capture that screen).
- **`⚠ the SPA also sent header(s) the adapter omits: …`** — a custom header (a per-account token) that
  *might* be required — replay it if the live call fails.

**Iterate until every output is `PASS`.** Note: a `keep.prefix` filter (routing deposits vs savings by
id) can show `listed=0` offline when the capture's ids are redacted — that's expected; the *requests*
are still verified. Also validate structurally:

```bash
node -e 'import("./extension/src/adapters/validate.js").then(m=>console.log(m.validateAdapter(require("./your-source.json"))))'
```

---

## 5. Submit

- Bump `version` (`YYYY-MM-DD[.N]`). Set `minVersion` if you used a feature only in a newer runtime.
- Open a PR adding `sources/<id>.json` to **[`habeas-dev/sources`](https://github.com/habeas-dev/sources)**
  (the extension's *Share* button prefills this). Include a note on what you verified.
- **Do not** include your capture. Do not add any proxy tooling to Habeas.

Once merged and in `index.json`, everyone can install it from the extension's marketplace. See
[registry.md](registry.md) for the catalogue mechanics and [RELEASING.md](RELEASING.md) for how a
maintainer publishes.

---

## Appendix — a prompt for your AI agent

> You are helping author a **Habeas source** — a *declarative data object* (never code) that teaches a
> browser extension to read a user's own data from a service. Read `docs/AUTHORING-SOURCES.md` and
> `extension/src/adapters/validate.js` (the schema authority), `extension/src/runtime/inventory.js`
> (the runtime features), and `extension/src/sinks/format.js` (record schemas) in this repo, plus a
> couple of examples under the published catalogue. I will give you a **mitmproxy capture** of my
> signed-in session. Produce: (1) the source JSON, and (2) a `bundle.json`
> (`{samples:[{url,method,reqBody?,reqHeaders?,json}], assets:[…]}`) built from the capture. Then run
> `node scripts/replay-capture.mjs bundle.json source.json`, read the failures, and iterate until every
> output PASSES. Rules: adapters are DATA (no functions/eval); respect the same-registrable-domain
> guard (use `crossDomainHosts` for a genuinely different API domain); never put my real capture in the
> repo; synthesize any example/test values from scratch.
