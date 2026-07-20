# Habeas — Claude Code context

> Working context for the **Habeas** repo. Develop it independently of Tiquetera/Cuéntamo
> (those are separate apps that merely *consume* Habeas output).

## What this is

**Habeas** is an open-source (AGPL-3.0) **Manifest V3 browser extension** (Chrome/Chromium
**and** Firefox) that lets a user extract their **own** personal data — receipts, invoices,
card/investment transactions — from services that hide it behind non-automatable walls
(Cloudflare, Akamai…) and offer neither an API nor an email export.

- Site: **habeas.dev** (landing served from `docs/` via GitHub Pages, HTTPS enforced).
- Repo: **github.com/habeas-dev/habeas** · npm placeholder: **habeas**.

## Core thesis (do not lose this)

Client-side-in-session beats server-side scraping. Because the extension runs **inside the
user's real, already-authenticated browser session**, it never fights anti-bot (inherits the
user's valid Cloudflare/Akamai session), never stores credentials (the user logs in
themselves), and lets the user resolve MFA/OTP live. The opposite of how Plaid/Tink/TrueLayer
operate. Every decision must preserve this.

## Status — working beta (published on Chrome Web Store + Firefox AMO)

**16 sources published** to the community registry (Carrefour, Dia, Hover, Decathlon, Bip&Drive,
Leroy Merlín, WiZink, CaixaBank Consumer, IKEA, Amazon, AliExpress, Openbank, Revolut, Trade Republic,
**ING España** — a 3-output bank source: movements + per-account monthly statements PDF/Excel + integrated
monthly statement PDF — and **Financiera El Corte Inglés** — a 3-output store-card source: movements +
aplazamientos + monthly statement PDFs, cookie session + a rotating WSO2 bearer scoped to `/dashboard/*` via
`auth.capturePaths`). Implemented:
capture → inventory → sinks (download / local-folder / **native Google Drive** / http / **WebDAV** /
**S3 (+compatible)** / **Dropbox**), per-sink dedupe, **automatic mode** (sync new docs on login) +
**Sync all** (sweep every source), activity log + badge + notifications, **source categories + sink
`accepts` filtering**, a **persistent per-account filter** for grouped bank sources, a cross-source
**Documents browser** + a **canonical-store inspector** (with delete), a light **declarative
normalization** layer (counterparty extraction + a uniform `canonicalize` output, opt-in per sink) with
**`record.extra` keepRaw**, full **i18n (en default + es)**, a **landing site**, and **CI packaging**.

**External hooks** (`lib/exthooks.js` · `lib/grants.js` · `content/extbridge.js` · `ui/authorize.*`):
any website can, via `window.postMessage` (bridge on all https pages, both browsers — no allowlist),
**propose** a `source → its-own-origin http sink` workflow and later **request collection**. Two
enforced rules: **origin-bound sink** (the sink URL host MUST equal the requesting origin — a site
can only route your data back to itself) and **explicit consent** (`ui/authorize.html`). Approval
mints a **grant** (`storage.local habeas:grants`, one origin→one route) revocable in Settings →
Site integrations. `collect` always runs in a **dedicated tab** (foregrounded only for manual login;
never handles credentials), debounced + logged, no notification. See `consumers/external-hooks.md`.

**Community sources system** (LIVE — 16 sources published): a **generalized runtime**
(declarative pager `offsets|offset|page|cursor|none|years|synthetic`, dotted field paths **+ array
selectors** `key[field=value].sub`, schemas `receipt|invoice|transaction|investment`, optional PDF/Excel;
`synthetic` = documents that exist once per period/account, e.g. monthly statements); an **adapter loader
+ validator** with a **same-registrable-
domain security guard** (a source's captured session can only be replayed to its own eTLD+1; cross-
domain needs an explicit `crossDomainHosts` allowlist + a **consent** screen); **record mode**
(learn-mode hook captures response samples in-session → `runtime/infer.js` auto-drafts a source →
visual mapper `ui/author.*` → test → save); and **sharing** (export/import JSON, prefilled PR to
`habeas-dev/sources`, `ui/marketplace.*` browse/install from `index.json` + ratings/comments client).
External infra is LIVE: the `habeas-dev/sources` catalog at `habeas-dev.github.io/sources/index.json`,
and the ratings/comments service at `https://api.habeas.dev` (Cloudflare Worker + D1, repo
`habeas-dev/api`; contract in `docs/registry.md`). Only real, API-verified
sources ship or get published; fictional design skeletons live in `extension/test/fixtures/` as
test-only fixtures and never appear in the extension.

## Repo layout

```
habeas/
├── extension/              # THE EXTENSION — authoritative code lives here
│   ├── manifest.json       # MV3; dual background (service_worker=Chrome, scripts=Firefox, type module)
│   ├── icon*.png/.svg       # logo (light + dark variants); topbar/hero use the light one
│   ├── _locales/{en,es}/    # chrome.i18n messages (en = default_locale)
│   ├── fonts/               # self-hosted Space Grotesk + Inter (no third-party requests)
│   └── src/
│       ├── background.js    # captured auth (storage.session) + auto-sync runner + sample buffer
│       ├── lib/             # ext.js (browser??chrome shim), config, secrets, state, fs, zip,
│       │                    #   naming, badge, theme-icon, i18n, consent, learn (record mode)
│       ├── adapters/        # loader.js (built-in + community from storage.local, validated),
│       │                    #   validate.js (schema + same-domain guard), carrefour-es.js,
│       │                    #   (test-only skeletons live in extension/test/fixtures/, never shipped)
│       ├── content/         # bridge.js (isolated) + hook.js (page): capture JWT+CSRF; learn-mode samples
│       ├── runtime/         # inventory.js (declarative pager: offsets|page|cursor|none) + infer.js (auto-draft)
│       ├── registry/        # share.js (export/import + PR) · client.js (index.json + ratings API)
│       ├── sinks/           # sinks.js · format.js (schema-aware records) · drive.js
│       └── ui/              # popup · options · author (record mode) · marketplace · theme.css
├── docs/                   # habeas.dev landing (GitHub Pages) + FUNCTIONAL-SPEC.md + CNAME
├── consumers/              # docs for external consumers (tiquetera.md)
├── package.json            # npm scripts: lint/build/package via web-ext
├── .github/workflows/build.yml   # CI: build MV3 zip on push, attach to releases on v* tags
└── adapters/ schemas/ core/ …    # EARLY-SKELETON design artifacts (spec docs), NOT the runtime code
```

`docs/FUNCTIONAL-SPEC.md` is the design spec (read for architecture rationale). The runtime
code is in `extension/src/` — the root `core/`, `schemas/`, `adapters/*.yaml` are early
scaffolding kept as design notes (safe to consolidate later).

## How it works (data flow)

1. **Capture** — `content/hook.js` runs in the page (injected by `bridge.js`), hooks
   `fetch`/XHR, and captures the auth headers the site's SPA sends to its API, **tagged by
   endpoint path**. Only the real user JWT (`eyJ…`) is kept (not anonymous/Basic tokens).
   `bridge.js` relays to `background.js`, which stores them in `storage.session` (never disk).
2. **Inventory** — the app tab (`ui/popup.*`) or the background reads the captured auth and
   `runtime/inventory.js` enumerates all documents (paginated) and assigns each a `category`.
3. **Send** — selected docs are fetched (PDFs) and handed to a **sink**. The manifest of
   normalized records is always included.
4. **Auto mode** — on login capture, `background.js` runs any `mode:auto` route: list → filter
   to NEW (per ledger) and to categories the sink accepts → send to a SW-runnable sink
   (drive/http) → mark delivered → notify.

## Data model

- **Adapter** (`adapters/carrefour-es.js`) is a plain JS object (data, not imperative code):
  `id, name, service, categories[], categorize{field,map,default}, match[], auth{tokenMatch,
  replayHeaders[]}, api{host,list{path,itemsPath,offsetsPath,window,params},pdf{path}},
  fields{…}, schema`. Add new sources as sibling files + register in `adapters/index.js`.
- **Normalized record** (`sinks/format.js#buildRecord`): per-schema shape (receipt: `{internalId, date,
  total, currency, category, store{name,address}, source, type}`; transaction/invoice/investment differ).
  Plus **`record.extra`** when a source sets `keepRaw` — every raw list-item field the schema didn't
  consume, so nothing captured is lost. Amount/currency are parsed (`money()`/`curOf()`: "$9.00" → 9 USD;
  never forces EUR).
- **Declarative normalization** (`lib/normalize.js`, wired in `runtime/inventory.js#mapDoc`): an adapter's
  `normalize.counterparty {from, re[]}` extracts a clean counterparty from free text (ING "Bizum enviado a
  X" → "X"); `canonicalize(record)` maps ANY schema to one uniform shape `{id,date,amount,currency,
  direction,description,counterparty,category,type,account,number,source,extra}` — delivered when a sink
  opts in via `sink.normalize` (consumer-friendly; default off keeps manifests byte-identical).
- **Grouped sources + account filter** — a source with `api.groups` (a bank, many accounts) enumerates
  accounts; a **persisted per-datasource allow-list** (`datasource.groups` + `groupLabels`) chosen in the
  popup's "Cuentas" picker restricts what listing/auto/sweep touch AND hides other accounts' stored docs.
- **Categories** classify each document (Carrefour: `HYPERMARKET`→`grocery`, `REFUELING`→
  `fuel`, default `retail`). **Sinks** may declare `accepts:{categories?,sources?}`; without
  it they accept everything. Two-layer filter: the UI only offers compatible sinks, and
  send/auto only deliver docs whose category the sink accepts (`format.js#sinkAcceptsSource`
  / `#acceptsDoc`). Lets a Tiquetera sink take only `grocery`.
- **Source outputs — streams × formats** (`lib/outputs.js`): a source may declare `streams[]` — each a
  distinct data set with its own `api.list`/`schema`/`fields` — and, per stream, `formats[]` (artifacts
  sharing the stream's items, overriding only `api.pdf`; e.g. a statement as PDF **or** Excel). A selectable
  **output** is a `(stream, format)` pair, id `"stream/format"`; `resolveOutput(adapter, id)` yields the
  effective adapter (base⊕stream⊕format), `outputsOf` lists them. The store/ledger key is per **stream**
  (`storeKeyOf(id, stream)` = `id:stream`) since formats share items. Manual mode defaults to **all** outputs
  (checkbox per output in the popup); a typed sink auto-selects via `outputsForSink`. A source with no
  `streams` is a single implicit output (fully backward-compatible). WiZink is the reference multi-output
  source (one source = movimientos + extractos-PDF + extractos-Excel). Validation is **per output**
  (`validate.js#checkExtraction`).
- **Config** (`lib/config.js`, storage.local): `{datasources[], sinks[], routes[]}`. **Secrets**
  (`lib/secrets.js`, separate store, `secret://` refs). **Delivery ledger + activity log**
  (`lib/state.js`). Directory handles for local-folder in IndexedDB (`lib/fs.js`).

## Carrefour specifics (hard-won)

- Login is on `www.carrefour.es` (**behind Cloudflare**; email OTP). The **API is
  `pro.api.carrefour.es`** (Google APIgee, **NOT** behind Cloudflare, CORS open).
- **List:** `GET /md-purchasesAccount-v1/purchases?from&to&count&ticketOffset&atgfOffset&
  atgnfOffset&…` (offset pagination via the returned `offsets`; tickets + online orders).
- **PDF:** `GET /md-ticketsAccount-v1/tickets/{purchaseId}/pdf`. **Retention:** only recent
  tickets have a PDF; older ones return **406** → not an error, exported as metadata only.
- **Auth to replay:** the user JWT (`authorization: bearer eyJ…`) **+ `x-xsrf-token` +
  `x-csrf-token` + `requestorigin`** (validated per endpoint — the extension captures headers
  per path and replays the ones the SPA used for `purchases`).

## Cross-browser notes

- **`lib/ext.js`** exports `const chrome = globalThis.browser ?? globalThis.chrome` — imported
  in every module using extension APIs so promise-based calls work in Firefox too. New modules
  that touch `chrome.*` MUST import it (content `bridge.js` inlines the same shim).
- **Background:** manifest has both `service_worker` (Chrome) and `scripts` (Firefox), `type:
  module`. web-ext lint warns that Firefox ignores `service_worker` — expected.
- **Gaps in Firefox:** File System Access (`local-folder` sink) is Chromium-only → the option
  is hidden and guarded on Firefox. Google Drive OAuth `launchWebAuthFlow` uses a
  **per-browser redirect URL**, so the shipped client only targets Chromium; Firefox users
  must register the Firefox redirect (shown in Settings) on their own OAuth client.

## Identity & secrets

- Domain `habeas.dev`, GitHub org `habeas-dev`, npm `habeas`.
- **Google Drive OAuth client** (public, scope `drive.file` → no CASA): default client id is
  hardcoded in `sinks/drive.js` (`246972215385-…apps.googleusercontent.com`). Client ids are
  public, not secrets. Redirect URI registered = Chromium's `chromiumapp.org` one.

## Build & CI

- Local: `npm install` then **`npm run package`** (lint + `web-ext build` → `dist/…zip`). The
  same MV3 zip loads in Chrome and Firefox. `dist/` is gitignored.
- CI (`.github/workflows/build.yml`): builds the zip on push/PR, uploads it as an artifact,
  and attaches it to a GitHub Release on `v*` tags.
- Load unpacked: Chrome `chrome://extensions` → Load unpacked → `extension/`. Firefox
  `about:debugging` → Load Temporary Add-on → `extension/manifest.json` (or the zip).

## Non-negotiable rules

1. **Adapters are DATA, not code.** No `eval`, no remotely-hosted JS (also an MV3 rule).
2. **Local-first.** Data never leaves the browser unless the user picks a sink.
3. **No credential storage, ever.** Rely on the live session; the session token lives only in
   `storage.session` (memory, cleared on browser close).
4. **Same registrable domain is the enforced trust boundary.** Every host a source touches
   (its `match` site, its `api.host`) must share ONE eTLD+1 — so a captured session can only ever
   be replayed to the *same* service it was captured from. Cross-domain is allowed **only** via an
   explicit `crossDomainHosts` allowlist, which forces a prominent off-site **consent** screen.
   This makes silent credential exfiltration structurally impossible regardless of category, so
   community sources — **financial included** — are permitted under the guard. Trust is surfaced
   as a *label* (`first-party` audited vs `community`), not a category block. Enforced in
   `adapters/validate.js` (`checkHosts`) + `lib/consent.js`.
5. **Triggers are user-initiated / on-login.** No background scraping with a stored session
   while the user is away.

## Legal posture

GDPR Art. 20 / *habeas data* — the user's own data, in the user's session, via user-run OSS.
Not a PSD2-regulated actor (no payment initiation). ToS of each service may restrict automated
access — documented, user's responsibility. Full write-up in `README.md` (Legal & Privacy).

## Conventions

- **Language:** code, comments, docs, commits in **English** (international OSS).
- **Commits:** conventional-commits, and **do NOT add `Co-Authored-By: Claude` or
  `Claude-Session` trailers** (history was rewritten to strip them; keep it that way).
- Keep the runtime small and auditable; push service-specific behavior into declarative
  adapters. Validate JS (`node --check`) and locale key parity (en/es) before committing.

## Maintainer playbook — versioning, commits, publishing

> Project conventions for anyone maintaining Habeas. Detailed release + registry steps: `docs/RELEASING.md`;
> Drive OAuth setup: `docs/drive-oauth.md`.

**Version cadence (`extension/manifest.json` `version`).** A 3-part **milestone** (`0.1.53`) + an optional
4th **dev suffix** (`0.1.53.N`).
- **Bump the dev suffix on every change** (`0.1.53.14 → .15`) so a reload is verifiable (the version shows in
  the popup + `chrome://extensions`). Dev suffixes are committed but **never tagged**.
- **Bump the milestone (drop the suffix → `0.1.54`) only at release time** — it groups many dev iterations.
  Then `git tag v0.1.54` + push the tag → CI builds the MV3 zip, attaches it to a GitHub Release, and uploads
  to CWS (and AMO, once approved). Never reuse a published version (CWS rejects it).

**Commits.** Conventional-commits, English, **no `Co-Authored-By` / `Claude-Session` trailers**, manifest
version bumped in the same commit. Commits are pushed to `main` as they land.

**Update `CHANGELOG.md` (root) on every version bump** — add the change under `## [Unreleased]` in the same
commit as the manifest bump (Keep a Changelog: Added / Changed / Fixed / Removed). At a milestone release,
rename `[Unreleased]` → `[X.Y.Z] — YYYY-MM-DD` and start a fresh `[Unreleased]`. (Older 0.1.x beta detail
stays in `docs/CHANGELOG.md`.)

**Before every commit:** `npm test` green (node:test); `node --check` each touched JS; en/es locale-key
**parity** (both files same key set); `npm run lint` (web-ext) → **0 errors** (expected warnings: `innerHTML`
UNSAFE_VAR_ASSIGNMENT; and `identity.getAuthToken/removeCachedAuthToken not supported by Firefox` — guarded).
Author new/updated sources from a real API capture kept **outside the repo**, and never commit capture files
(they hold real user data) — validate with `validateAdapter` and run the runtime against the captured
response (mock `net` into `listInventory`) before publishing; only real, API-verified sources ship.

**Community-sources registry (a SEPARATE repo).** `sources-repo/` is a staging copy tracked in THIS repo.
The LIVE catalog is a separate repo `git@github.com:habeas-dev/sources.git` (served at
`habeas-dev.github.io/sources`) with its **own independent history** — **never subtree-split / force-push it**;
publish by applying the changes in a clone and pushing **non-force (fast-forward)** (full steps in
`docs/RELEASING.md`). Bump the source's `version` (compared lexicographically → the marketplace offers the
update; `YYYY-MM-DD`, or `YYYY-MM-DD.N` same day). `minVersion` gates by extension version
(`lib/version.js#cmpVersion`); if a source needs a runtime feature only present in a newer build, set
`minVersion` to that build so older installs stay gated.

## Consumers (decoupled — separate projects)

- **Tiquetera** (Spanish grocery-receipt app) — accepts `grocery` via an HTTP sink
  `accepts:{categories:["grocery"]}`. See `consumers/tiquetera.md`.
- **Cuéntamo** (personal finance) — future `transaction`/`investment` sources. Note: for banks,
  PSD2 AIS (licensed aggregator) is the primary path; Habeas covers what PSD2 doesn't (cards,
  investments, pensions). Financial sources are allowed from the community under the same-domain
  guard + consent (rule #4); first-party ones simply carry the audited `first-party` trust label.

## Roadmap / pending

- ~~Stand up community infra~~ DONE: `habeas-dev/sources` (Pages, LIVE) + `api.habeas.dev`
  (Cloudflare Worker + D1, LIVE). Optional: add CF secrets to `habeas-dev/api` for CI auto-deploy.
- **Author real sources** (ONGOING) — **11 published** so far (Carrefour, Dia, Hover, Decathlon,
  Bip&Drive, Leroy Merlín, WiZink, CaixaBank Consumer, IKEA, Amazon, **ING España**), all API-verified
  against real services. Keep going via record mode / community PRs (the fictional test fixtures must
  never be published or shipped). Pending targets: obramat, AliExpress, Pepe Energy, Pepephone,
  Financiera El Corte Inglés, Revolut, TradeRepublic, Openbank, Raisin, Telepizza.
- **HTTP → Tiquetera / Cuéntamo** ingest endpoint (POST normalized records + PDFs; pairing token). The
  category model + the opt-in **`sink.normalize` uniform canonical record** (`lib/normalize.js`) already
  support it — the consumer side still needs building.
- ~~Encrypt secrets at rest~~ DONE: `lib/secrets.js` stores AES-GCM envelopes (`lib/crypto.js`)
  keyed by a non-extractable IndexedDB CryptoKey (`lib/keystore.js`); legacy plaintext migrates on
  read. Keeps credentials out of plaintext `storage.local` — not a defense against a stolen profile
  (no stable user secret in MV3). Externally-proposed sinks' pairing-token headers now also go to the
  secrets store via `sink.headersRef` (`lib/sinkheaders.js`; legacy plaintext `sink.headers` migrated
  on background startup + still honored at send). The Path-B `gdrive:*` OAuth token is also encrypted
  (`sinks/drive.js` via `secrets.js#encryptString`; only `expiresAt` stays plaintext, legacy plaintext
  self-heals on the next ~1h refresh). Only non-encrypted at-rest state left is non-sensitive (config,
  ledger, grants) and the memory-only `storage.session` scraped auth (rule #3, never disk).
- ~~Harden dynamic HTML~~ DONE: all network/source/OS-derived values in `ui/popup.js` + `ui/options.js`
  now escaped via a single shared `lib/esc.js` (was 7 duplicated inline helpers). web-ext/AMO still
  flags `innerHTML` structurally, but no unescaped dynamic sink remains.
- ~~AMO + Chrome Web Store submission~~ DONE: **published on both** (AMO approved/live; CWS live, a new
  milestone waits its turn while the previous one is in review — `ITEM_NOT_UPDATABLE` until it clears).
  Firefox Drive OAuth redirect still per-user. MV3 review note: `scripting` +
  `optional_host_permissions: https://*/*` (record mode) needed justification at store review.
- **Consumers** — build the Tiquetera/Cuéntamo ingest endpoints (the `sink.normalize` canonical output +
  `record.extra` are ready on the Habeas side).
