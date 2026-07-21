# Changelog

All notable changes to the **Habeas** extension. The format is based on
[Keep a Changelog](https://keepachangelog.com/). Versioning is a 3-part **milestone**
(`0.2.0`) plus an optional 4th **dev suffix** (`0.2.0.1`, bumped on every change, never tagged);
only milestones are tagged and shipped to the stores. Dates are `YYYY-MM-DD`.

Update this file in the **same commit** as every version bump (see `CLAUDE.md` → Maintainer playbook).
Older detail (0.1.x public beta) lives in [`docs/CHANGELOG.md`](docs/CHANGELOG.md).

## [Unreleased]

### Fixed
- **A guided re-recording reads clearly in the conversation.** The message that accompanies an attached
  recording is now a plain "📎 recording sent" note instead of echoing the team's instruction verbatim (which
  looked like a duplicate of the team's message).

### Added
- **A report shows the actual request context — SPA vs our replay** (`lib/diag.js#pushReqCtx`/`formatReqCtx`,
  `background.js`). The webRequest observer already sees the FULL headers a request carried, including the
  browser-set `Origin`/`Referer`/`Cookie` the in-page sample hook drops — and it fires on BOTH the site's own
  request AND our replay fetch to the same URL. "Report a problem" now includes a **redacted** context line per
  observed request (header *names* only, host-level origin/referer, cookie *presence*, and the HTTP status), so
  the team can diff a **working request (HTTP 200)** against a **failing one (HTTP 401)** — "the SPA's
  `/accounts` carried a cookie + these headers; our 401'd one didn't." Each line also shows the sent bearer's
  **issuance timing** (`token(iat …, exp …)` — decoded from the JWT, ONLY the `iat`/`exp` timestamps, never the
  token or any identity claim), so a **rotated/revoked-but-unexpired** token is visible: the working request
  and our failing one carrying **different `iat`** proves we replayed a token one rotation behind the SPA's
  live one. Never stores header values, cookies, tokens, or query strings. (The instrumentation gap that a
  valid-token-still-rejected source like Raisin exposed: the difference was in things the recording couldn't
  show.)
- **A failed auth request says whether the token was expired.** The in-session page fetch decodes the SENT
  bearer's own claims (exp / iss — never the raw token), and the list/groups diagnostic appends its status,
  e.g. `[token EXPIRED 13min ago iss=auth.weltsparen.de]` or `[token valid 600s]`. So "Report a problem"
  answers "was the token stale?" from the report alone — no DevTools. (This is the gap that made a
  short-lived-token source like Raisin so hard to diagnose.)
- **Tokens are correlated in a recording, like ids** (`lib/redact.js`) — the same token value now gets the same
  `[jwt#N]` tag across a **sent `Authorization` header** and **client storage/memory** (kept in a separate map
  the orphan review never reveals, so a live token is never exposed). A sent bearer is redacted to its scheme +
  the tag (`Bearer [jwt#N]`) instead of dropped. So the team can see, from the redacted bundle alone, whether
  the API bearer is the same token as e.g. `localStorage.auth_token.access_token` — the exact question that
  cost several Raisin rounds — without anyone opening DevTools.
- **A recording surfaces where its tokens live** (`lib/redact.js#collectStorageTokens`) — the redacted handoff
  now includes `tokenLocations`: a safe map of client-storage paths that hold a JWT, tagged access / refresh /
  id (paths only, never a token value). So the team can wire `auth.tokenFromStorage` at the right field (e.g.
  `localStorage.auth_token.access_token`) from a non-technical contributor's recording alone — no DevTools.

### Changed
- **`auth.tokenFromStorage` can auto-detect the access token.** With no `field`, it parses the stored value
  and picks the ACCESS token from a token object (`{access_token, refresh_token, id_token}` or keycloak-js
  `{token, refreshToken, idToken}`) — requiring a real JWT and skipping id/refresh tokens, so a short-lived
  bearer is read FRESH on every request instead of a captured one that may have expired (Raisin's ~5-minute
  Keycloak token: "Jwt is expired").

### Added
- **`keep` item/group filter by field presence or id prefix** (`runtime/inventory.js`) — `keep` now also
  supports `present: true|false` (keep by whether a field exists) and `prefix` (keep items whose field starts
  with a string, or any of an array). For a list that mixes product kinds distinguished by a field's presence
  or an id namespace — e.g. routing Raisin's `OMA_…` flexible accounts and `FDA_…` fixed deposits to their own
  outputs. Unit-tested.
- **"Completed" handoff status** — a collaboration session that finished with a complete source is marked
  completed (shown as "✓ completed" in My contributions). Completed/published/declined/superseded sessions no
  longer count as "waiting for the team", so a finished collaboration drops out of the active queue.
- **Targeted capture requests** — the team can ask a contributor to record one specific thing, in plain
  language, without any technical back-and-forth. A capture request appears in the contribution conversation
  as a guided card ("The team needs one more recording" + the plain instruction); tapping it opens the
  recorder prefilled with the source site and the instruction, and — given an endpoint hint — the recorder
  lights up "✓ got what the team needs" the moment that request is captured, so a non-technical contributor
  knows they did it right before sending. **The guided recording attaches to the SAME handoff** (it lands in
  the existing conversation as a supplementary recording), instead of spawning a new, disconnected handoff.
  (Backend: a capture-request message + a handoff_recordings table, alongside the version messages.)
- **Rolling relative-date token** (`runtime/inventory.js#tmplDates`) — `{daysAgo:N}` resolves to the ISO date
  N days before today, for a request that caps itself to a rolling window (e.g. Raisin sends
  `date_from=today-90d` to stay inside its SCA-free window).

### Fixed
- **Superseded submissions no longer clutter My contributions.** When a contributor re-records and replaces
  an earlier submission, the old (superseded) one is now hidden from their inbox — the live submission
  represents it. (Completed/published stay visible so the contributor sees their finished sources.)
- **Contribution thread buttons work again after a source is attached.** "Start guided recording" (capture
  requests) and "See technical detail" were wired to their buttons before later `innerHTML` updates rebuilt
  the thread DOM, silently discarding the handlers whenever a source version was present. Both now use a
  single delegated handler on the thread container, which survives the rebuilds.
- **Record mode no longer lets analytics beacons crowd out the real API calls.** Third-party telemetry /
  consent / tag-manager / feature-flag traffic (Datadog RUM, LaunchDarkly, Usercentrics, Transifex, Exponea,
  Cookielaw, …) fires constantly and was filling the capped sample buffer, evicting the endpoints a source
  actually needs (a Raisin recording came back 72% Datadog noise, having lost the deposits list and several
  account details). Those hosts are now skipped at the page hook, and the sample buffer cap is raised
  (60 → 120) for a thorough multi-account/-document session.

## [0.5.0] — 2026-07-20

### Added
- **Computed-date FORMAT on document tokens** (`runtime/inventory.js#fillDocTmpl`) — a document endpoint value
  can now format a date field, e.g. `{date:DD/MM/YYYY}`, parsing ISO / `DD/MM/YYYY` / `YYYY/MM/DD`. Needed
  when the API wants a specific date shape but the stored/record date is normalized to ISO (a store
  re-download has no raw item, so `{date}` falls back to the ISO `record.date`).

### Fixed
- **"Report a problem" sends again, with a timestamp per line.** The richer multi-line diagnostic exceeded the
  server's message length limit (1000 chars) and the send failed silently; the handoff-message limit is raised
  (diagnostics are team-facing, not public comments) and a failed send now says so instead of doing nothing.
  Each failure line is prefixed with its timestamp.
- **"Report a problem" now captures every failed request, and names which one.** The diagnostic used to keep
  a single overwritten error (so only the first/last failure survived) and didn't say where it happened —
  and a failed document/PDF fetch during a manual send was swallowed silently, so it looked like "no
  document". Now each failure appends a structured entry (phase, output/stream, document, method + URL, HTTP
  status, message), so a report shows the team **all** the failures and exactly which request produced each
  (e.g. `output=extractos … POST …/generate-file → HTTP 500`). Still shown to the contributor only as a plain
  line, with the full trace behind "See what's sent".
- **Auto-sync never runs during a login, and waits for the session to settle.** A captured token no longer
  launches an auto-run immediately: it now waits a short settle window after the last capture (coalescing the
  burst of authenticated requests a freshly loaded dashboard fires into a single run). And a source with an
  observable bearer (a bank's rotating token) only auto-runs once that token has actually been captured — the
  robust "the user is logged in" signal, since the token does not exist until after login. Together these stop
  auto-sync from firing in the middle of a fragile bank login (which could disturb the sign-in), regardless of
  whether a page navigation or a capture triggered it.
- **The token observer stays off the login flow (declarative capture paths).** A source can now declare where
  its token lives — `auth.capturePaths` (an allowlist of path prefixes) / `auth.ignorePaths` (a denylist) — and
  the request-header observer's URL filter is scoped to exactly those paths. So for a bank whose token only
  appears in its authenticated area (e.g. `/dashboard/*`, after login), the observer never engages with the
  sensitive sign-in requests. This replaces a broad observer that watched every request on the site and could
  interfere with a Transmit-Security/anti-bot login. Capture is also gated to those paths in the in-page hook,
  so a token is only ever taken from the area the source declares. No tab reload.

### Changed
- **Version sends are part of the contribution conversation, with history** (Settings → My contributions):
  each build the team sends now appears **inline in the timeline** as a build card (service name + version +
  Install/Reinstall), in order, next to the accompanying note — instead of a single box pinned below that was
  overwritten on every new build. The newest build is highlighted "New version" until it is installed here;
  **previous builds stay visible and reinstallable** ("Previous version"), so the contributor can see and
  re-test current and earlier versions.
- **Clearer, less technical contribution conversation** (Settings → My contributions):
  - Messages render as separated bubbles sided by sender (team vs you) instead of a run-on list.
  - The source the team attached shows its version with an unmistakable state: a highlighted "New version"
    until that exact version has been installed here (then "This version installed", with a Reinstall button),
    so a collaborating contributor can tell at a glance whether the team built a new version.
  - **"Report a problem" is always available** (it no longer vanishes after one report), so the contributor
    can flag each new failure; each report sends the freshest technical trace.
  - **A contributor is no longer bombarded with technical detail.** A report shows them only a plain "it didn't
    work"; the raw diagnostic (server errors, header/param names) rides hidden for the team. For transparency
    it is not secret: a **"See what's sent"** button reveals the exact payload before sending, and each sent
    report keeps a "See technical detail" toggle.

### Fixed
- **External-hooks bridge now runs on `http://localhost` / `http://127.0.0.1` too** (was https-only), so a
  consumer app in local development can talk to Habeas — `list-sources` ("detect sources") never appeared
  because the bridge wasn't injected on a plain-http localhost page. (`propose-workflow`/`collect` still
  require an https sink under the origin-bound rule.)
- **`list-sources` consent dialog no longer gets stuck** — a per-origin re-prompt was locked out for 5
  minutes, so if the user closed the consent window without deciding, clicking "detect sources" again did
  nothing. It now suppresses a re-open only while the window is actually still open, and re-opens otherwise.
- **Accurate `[sent: …]` in list/groups error diagnostics** — the page-side fetch now reports the headers it
  ACTUALLY sent (including a `tokenFromStorage`-injected `authorization`), and the runtime's error uses them.
  Before, the diagnostic listed the headers the runtime passed BEFORE page-side injection, so it always read
  `[sent: accept]` and couldn't reveal whether the token actually rode the request.
- **Document-fetch failures are no longer swallowed silently** — a failed per-document fetch during delivery
  (and a stream that lists items but produces no document at all) now records the reason to the report
  diagnostic, so "Report a problem" surfaces WHY a statement/PDF didn't download instead of a bare "0 documents".

### Added
- **`auth.tokenFromStorage`** (`lib/pagefetch.js#makePageFetch`) — read the bearer FRESH from the page's
  `localStorage` on every request (`{key, field, scheme, header}`), for SPAs that keep and rotate the token
  there (WSO2/Akamai-fronted, e.g. Financiera ECI's `aphishi-lws_at.t`). Capturing the token from a seen
  request is fragile — it's absent after a browser restart, or if a listing runs before the SPA made an
  authenticated call — which surfaced as a `groups 401 "User data is empty"` even right after a fresh login.
  Reading it in the site tab is reliable and always current; a fresh token overrides any captured one.
- **Per-group templating of `api.pdf.headers`** (`runtime/inventory.js#fetchPdf`) — a document endpoint can now
  carry `{group.*}` in its headers (RAW, like `api.list.headers`, so a base64 value is not URL-encoded), for a
  per-document fetch that needs the account/card's own header (e.g. a statement PDF that requires the card's
  encrypted-PAN header, not just the list).
- **Capture-replay harness** (`scripts/replay-capture.mjs`) — runs an authored adapter's runtime against a
  handoff's captured samples and reports, per output, whether it lists + fetches documents. Catches requests
  the adapter builds that the SPA never made: a missing/wrong query param or POST body is a hard failure with
  the exact field named; a header the SPA also sent is a warning (a header can't be proven required from a
  capture); redaction artifacts (truncated arrays, redacted base64) are tolerated (the request is verified
  even when the bytes can't be). Run it before shipping a source so the contributor's live test is the final
  confirmation, not the debugging loop. `node scripts/replay-capture.mjs --handoff <id> [--source <file>]`.
- **Computed calendar-date tokens for request values** (`runtime/inventory.js#tmplDates`) — a path/param/body
  value can use `{today}`, `{monthStart}`, `{monthEnd}`, each with an optional `:FORMAT` (e.g.
  `{monthEnd:DD/MM/YYYY}`, default ISO). For SPAs that stamp the current billing/period date into a request
  (a statement list that wants `?date_bill=31/07/2026`). Local calendar, date-only, no timezone shift.

## [0.4.1] — 2026-07-17

### Added
- **`list-sources` external hook** — a website can ask which sources the user currently has enabled, so a
  consumer can offer the relevant ones instead of hardcoding source ids. Consent-gated per origin (a
  lightweight `list-sources` grant, no route; the first ask opens the consent screen and returns `pending`,
  then the approval is remembered so later calls are silent). Returns **public metadata only** (id, name,
  service, categories, `first-party`/`community` trust label), never accounts, routes, sinks, or data.
  Shown and revocable in Settings, Site integrations. See `consumers/external-hooks.md` (§D).

## [0.4.0] — 2026-07-17

### Added
- **Store migration resolves array-selector field paths** — the one-time canonical-store migration
  (`lib/migrate.js`) now backfills nested/selected raw values (`key[field=value].sub`) from `record.extra`,
  mirroring the runtime's field resolver, and no longer skips `[...]` paths. Its marker was bumped
  (`renormalize-2`) so already-stored records pick up newly-mapped nested fields **offline** — no re-sync.
- **Per-record source-version stamp in the canonical store** (`entry.srcVersion`) — every store entry now
  records the SOURCE (adapter) version that last built or re-normalized its record (store metadata, never
  inside the delivered `record`, so consumer manifests are unchanged). Written on every capture/delivery and
  by the store migration. Lets a future migration tell what normalization/scale each item carries (e.g. re-scale
  only records older than a version that changed a field's scaling) instead of blanket-trusting or re-deriving.
  Absent = unknown/legacy (treated as oldest). Documented in `docs/canonical-store.md`.
- **One-time canonical-store migration** (`lib/migrate.js`, run once on background startup) — re-normalizes
  already-stored records to the current schema so pre-existing data matches the new normalization: bank
  movements gain `balanceAfter`/`valueDate` (backfilled from `record.extra`, minor-unit scaled where the
  source is), and Trade Republic records stored as `transaction@1` are upgraded in place to `investment@2`.
  Offline and best-effort (rebuilds from the record + its `keepRaw` `extra`, no re-fetch), idempotent, and
  gated by a marker so it runs once. The store is the source of truth, so this IS the conversion; a re-list
  also re-normalizes re-fetchable items via last-write-wins. After converting, only **read/write** sink
  ledgers (the cumulative-manifest, overwrite-safe ones: local-folder/drive/dropbox/webdav/s3) are reset for
  the changed sources so the next Sync re-pushes the corrected records — ephemeral/one-way sinks (download,
  http) are deliberately left alone. Adds a small `normalize.map` recognized by the migration and the runtime.
  Scaling/normalization is applied **only** to fields pulled from raw `record.extra`; a field filled from a
  sibling record field (already normalized) is carried as-is, so a money field is never double-scaled.
- **Runtime support for `valueDate` / `balanceAfter` and a declarative value map** — `runtime/inventory.js`
  promotes a mapped `valueDate` (ISO-normalized) and `balanceAfter` (amount-normalized **and** minor-unit
  scaled like `amount`) to first-class record/canonical fields; `lib/normalize.js` gains a declarative
  `normalize.map` value map (`{ field: { from, map, default? } }`) so a source can map, e.g., a code to an
  enum without imperative code. (Which sources use these — and how — lives in each source's own definition.)
- **Broker schema `investment@2`** (`sinks/format.js`) — a richer investment record for the Cuéntamo data
  contract: a `recordType` `"trade"|"cash"` discriminator (inferred when absent), a structured
  `instrument{isin,ticker,mic,name,assetClass}`, `side` enum (buy/sell/dividend/split/transfer_in/
  transfer_out) and settlement breakdown (`grossAmount/commission/taxWithheld/netAmount/exchangeRate/
  assetClass/settlementAccount`) for trades, and a `kind` enum (interest/deposit/withdrawal/fee/tax/other)
  with `amount`/`description`/`account`/`direction` for cash movements. An unrecognized `side`/`kind` is
  kept verbatim. `investment@1` keeps its historical flat shape.
- **Bank canonical enrichment** (`lib/normalize.js#canonicalize`) — the uniform canonical `account` is now a
  **structured object** `{iban?,last4?,groupId?,currency?}` (derives `last4` from an IBAN / masked PAN and
  `groupId` from the source group; passes a pre-structured account through; falls back to the historical
  string when nothing can be derived). `valueDate`/`balanceAfter` are promoted from `record.extra` to
  first-class canonical fields when a bank source captures them, and `transaction@1` records now carry
  `account`/`valueDate`/`balanceAfter` when mapped (byte-identical when absent). Closes the Habeas-side gap
  in `consumers/cuentamo-data-contract.md` (§F).
- **Record mode captures realtime transports** — the in-session recorder now wraps `WebSocket` and
  `EventSource` (in learn mode only) and records the connect URL + a capped, chronological sample of sent
  (subscription) and received (data) frames into their own buffer. Recording was fetch/XHR-only, so
  `wss://` sources (Trade Republic-style) were **invisible** to it — a helper browsing such a site captured
  nothing usable. Now a plain browse session captures what a maintainer needs to author the transport, and
  the author panel reports the frame/socket count instead of "no requests". (First step toward making
  recording practical for non-technical helpers; auto-drafting realtime/mtop sources is still manual.)
- **Live recorder monitor** — while recording, the author panel now shows, in plain language and updated
  every ~2s, what the capture is seeing: documents found, data lists, realtime frames, which transport(s)
  detected, and whether it's ready to auto-draft here or needs a maintainer. A non-technical helper can
  tell it's working without pressing Analyze or understanding fields.
- **Capture classification** (`infer.js#summarizeCapture` + `findComponentGroups`) — the inference now
  recognizes **component-keyed lists** (sibling-key responses like mtop/DIDA `pc_om_list_order_*`, not just
  JSON arrays / HTML tables) and classifies the transport (HTTP / mtop / WebSocket / SSE), counting the
  user's data and honestly flagging signed/streamed sources as "needs a maintainer" rather than
  mis-drafting them.
- **PII-redacted recording handoff** (`lib/redact.js`) — a helper can share a recording with a maintainer
  without leaking personal data. The redactor keeps the STRUCTURE a maintainer needs (endpoint path
  templates, field names, response shapes, pagination params, transport) and replaces every VALUE with a
  type-classified placeholder (`[date]`, `[amount:EUR]`, `[id]`, `[email]`, `[iban]`, `[text]`, …); auth
  tokens, cookies, and page text are never included at all. The author panel's live monitor offers
  “Share recording (anonymized)” (with a “See what will be shared” preview) → downloads a redacted JSON
  bundle to send. Backed by a dedicated security test asserting no PII of any shape survives.
  - Handoff **keeps non-PII query-param values** (`redactParam`): filter/enum/date values an author needs
    for pagination (`paginationType=CLOSE`, `monthFilter=202506`, `from=2026-06-01`) are preserved, while
    ids, tokens, long numbers, emails, and multi-word values are still redacted.
  - Record mode now **captures document (PDF/Excel/CSV) downloads** via a learn-mode `webRequest` watcher
    — a PDF opened by a link/navigation/download bypasses the fetch/XHR hook (so recordings showed 0
    documents); the watcher records document-type responses on the recorded domain into the assets buffer.
- **Handoff collaboration workflow** — a helper can now **send a redacted recording to the Habeas team**
  (not just download it) and collaborate to turn it into a source. The author panel gains a “Send to the
  Habeas team” button + an optional credit handle; submissions are keyed by a **pseudonymous contributor
  id** (`lib/submitter.js`, no PII, no account). Backed by the `api.habeas.dev` handoff endpoints
  (reception, a two-way Q&A thread, status, and attribution) — see the api service.
  - **My contributions** inbox (Settings tab) — the return half of the loop: it polls the contributor's
    own submissions, shows each one's status, and opens the two-way conversation so they can answer the
    team's questions or re-record. An unread-reply badge appears on the tab.
  - **Marketplace attribution** — a source can carry a `contributors` handle list (in the adapter, carried
    into the catalog index); the marketplace card credits them (“🙌 Contributed by …”). Closes the loop:
    record → send → collaborate → published & credited.
  - **Correlation-preserving redaction** — an id VALUE now redacts to a stable `[id#N]` per distinct real
    value across the whole bundle, so a maintainer can trace that a path segment, a header, and a response
    field hold the SAME id (answering “where does this come from?” structurally, no questions, no value
    revealed). Personal values (names/IBANs/cards/emails/phones) are never correlated.
  - **System/operation codes preserved** — short numeric codes (≤4 digits, e.g. an operation-type code
    `0006`/`0019`, a center/department code) are kept verbatim since they identify the system, not the
    person; longer numbers (postcodes, accounts) are still redacted.
  - **Redacted JWT claims** — SPAs often build a path/query id from a claim in the session token, which
    made that id untraceable. The handoff now includes the JWT's decoded PAYLOAD claims (claim names +
    value-redacted, correlated) as `tokenClaims` — so a JWT-derived path id (e.g. `[id#9]`) is traced to
    its claim structurally (decoded from JWTs in both auth headers and response bodies — an SPA often reads
    an id from a JWT the login returns even when the bearer header is opaque). The raw token/signature are
    never included.
  - **Client-storage capture** — record mode now snapshots `localStorage`/`sessionStorage` (learn-mode
    only, debounced), included in the handoff **redacted + correlated**. SPAs stash session/entity ids
    there that never hit the network, so a path/query id can now be traced to the storage key it comes
    from. Values are redacted (JSON deep-redacted, JWTs decoded to claims); keys keep their names with
    id-runs redacted.
  - **Orphan-id review (ask-before-redact)** — an id that appears ONLY in requests and in no source
    (response / JWT claim / storage) can't be traced, so it blocks authoring. Before sending, the author
    panel now surfaces just those un-derivable ids (`findOrphans`) and lets the owner opt in to share the
    real value of the ones that are non-personal system/entity ids (`revealOrphans`) — everything else
    stays redacted. Only the handful of orphans are ever shown, never the hundreds of traceable ids.
  - A submission now carries the contributor's **browser locale** so the team knows which language to reply
    in (shown in the team list / record).
  - **One-click source install** — the team can attach the authored adapter JSON to a handoff (`POST
    /handoff/:id {sourceJson}`); the contributor's *My contributions* inbox then shows an **Install & test**
    button that installs + enables the source (consent + capture perms) with no manual JSON import. So a
    non-technical contributor can test what the team built.
  - **Knowing you have pending messages** — a background poll (every ~20 min + on startup) notifies the
    contributor when the Habeas team replies to one of their handoffs, and the popup shows a notice — no
    need to open Settings. Team side: the admin handoff list now flags `waitingForTeam` + `lastFrom`, so a
    maintainer sees at a glance which submissions need attention.
  - **One-click problem report** — when a List test fails, Habeas remembers the failure (status + the
    server's response snippet + which header NAMES were sent — never values); *My contributions* shows a
    **Report a problem** button that posts that diagnostic (scrubbed) to the team thread. A non-technical
    contributor can send back exactly what a maintainer needs to fix the source, with no DevTools.

- Runtime: **`paramSets` list pager** — replay a FIXED set of disjoint filter-views the SPA uses to load
  "all" (FECI's movements arrive as `monthFilter` N/A/S tabs, not pages) and UNION them, deduped. Derived
  straight from the recording (the exact param sets the app fetched — no guessing).
- Runtime: **per-group header templating** — `api.list.headers` values now resolve `{group.*}` (e.g. a
  card's own `eci-custom-encrypted-pan` header rides that card's movements list).

### Fixed
- **Canonical `account.last4` for grouped card sources** (`lib/normalize.js#acctObj`) — the last-4 is now taken,
  most-reliable first, from the IBAN → the group label's trailing 4 digits (the card number the user
  recognizes) → the account string's own digits. Cards whose `account` field is an opaque internal id, or is
  unmapped, previously produced a wrong or missing `last4`; now every bank/card source derives a correct
  structured `account` through the shared `canonicalize` path with no per-source change.
- Per-group header values are sent **verbatim** — `tmplGroup` URL-encoded the value (via `tid`),
  which corrupted a base64 header like a card's encrypted-PAN (`+`/`=` → `%2B`/`%3D` → server base64 error).
  Headers now use a raw templater.
- Author page no longer fails to load — a duplicate `esc` import (added with the orphan review) was a
  `SyntaxError` that broke the whole module.

## [0.3.0] — 2026-07-16

### Added
- **Download planner** — schedule recurring deliveries from a source to a destination. Versatile
  recurrence: every day; weekly on chosen weekdays; monthly on days-of-month; the nth (or last)
  weekday of the month; the nth (or last) business day (Mon–Fri) — all at a local `HH:MM`. Runs in
  the live browser session (never stores credentials): if not signed in when it fires, it opens the
  source tab + notifies, then retries every 15 min (up to 4×) before deferring to the next
  occurrence; a browser that was closed runs the missed schedule on next start (catch-up). Uses
  `chrome.alarms` (cross-browser). New **Planner** tab in Settings.
- **mtop transport** (`api.mtop`) — a reusable in-tab mechanism for Alibaba's `mtop` gateway (Taobao /
  Tmall / Lazada / 1688 / AliExpress…): reuses the app's own live **signed** request payload
  (`window.__habeas_mtop`, stashed by the page hook) + its `lib.mtop` signing — no hardcoded payload, no
  forged anti-bot signature. Items are read from the DIDA component response via `itemsFromKeys` (a key
  prefix, wildcard-tolerant to component-version bumps); pagination bumps the page field through the seed's
  nested stringified-JSON layers (`pagePath` with `~` markers); the seed is acquired **automatically** (nudge
  the tab — scroll + any "load more" — until the app fires its own signed request).
- Runtime: **mtop detail calls** (`api.detail.mtop` with an explicit `params` payload) and a **declarative
  receipt template** for `renderInvoiceHtml` (`api.detail.template`: title/meta/blocks/items/totals with
  `{dotted.path}` tokens resolved against the detail JSON) — a reusable HTML-invoice layer, data not code.
  The detail call is **locale-global**: params resolve from the user's own session in-page (`@seed:FIELD`
  reuses the app's own request locale, `@tz` the browser offset), dropping unresolved ones so the server
  falls back to the account default — no hardcoded country/language.

### Fixed
- `normalizeDate` handles `DD Mon, YYYY` (e.g. `15 jun, 2025`) — was shifting a day via the
  `Date()` fallback + UTC conversion.

## [0.2.0] — 2026-07-15

### Added
- **WebSocket transport** (`api.ws`, in-tab `makePageWs`) — the first non-HTTP source mechanism: run
  a `connect → sub → paginate → collect` loop inside the site tab so the session cookie rides the
  socket. Optional per-item detail phase.
- Runtime: async document **export job** (`api.pdf.job` — POST start → poll status → download) for
  documents a service generates on demand.
- `synthetic: "months"` now carries per-month `fromDate`/`toDate` bounds.

### Fixed
- Synthetic monthly documents (statements) are no longer marked as *existing* in **All documents**
  until actually delivered — phantom months (before the account opened) don't show a file anymore.

## [0.1.68] — 2026-07-15

### Added
- Runtime: **currency-aware minor-unit scaling** (`minorUnits`, per ISO 4217 exponent); the
  **`cursorFromItem`** pager (next cursor = the oldest row's field); **cookie-source header
  capture/replay** (`auth.replayHeaders` on `mode:cookie`); regex **field extraction**
  (`normalize.fields`, e.g. an ISIN out of an icon path); `api.pdf.poll` (async doc generation).

## [0.1.67] — 2026-07-15

### Added
- Runtime: token-only cookie policy (`auth.cookies:false`, avoids oversized-cookie HTTP 413); array
  `itemsPath` (first non-empty wins); cursor `nextIsUrl` / `stopPath` / `cursorParams`;
  `groups.derive` (split a packed field); session **keep-alive**; `keepRaw` store re-download.

### Dev tooling
- **PII/secret pre-commit guard** (`scripts/scan-pii.mjs` + hook) — blocks committing real account
  numbers, IBANs, live tokens, or raw capture dumps.

## [0.1.54] – [0.1.66] — Public beta — 2026-07-12 … 2026-07-14

Highlights (full detail in [`docs/CHANGELOG.md`](docs/CHANGELOG.md)):

- **Delivery destinations (sinks)**: download, local folder, **Google Drive**, **WebDAV**, **S3**
  (and S3-compatible), **Dropbox**, HTTP — with per-sink dedupe.
- **Automatic mode** (sync new docs on login) + **Sync all** (sweep every source), activity log,
  badge, notifications.
- **Grouped bank sources** + a persistent **per-account filter**; a cross-source **Documents
  browser** + a canonical-store inspector.
- **Declarative normalization** (counterparty extraction + a uniform `canonicalize` output) and
  `record.extra` (`keepRaw`); currency parsed from the amount itself.
- **Community sources system** LIVE: generalized declarative runtime, adapter loader + validator
  with the same-registrable-domain guard, **record mode** + visual mapper, and sharing (export/import
  + prefilled PR). External infra: the `habeas-dev/sources` catalog + the ratings/comments API.
- Published on the **Chrome Web Store** and **Firefox AMO**.

## [0.1.5] – [0.1.53] — Early development — 2026-07-03 … 2026-07-12

- Initial **Manifest V3** extension (Chrome + Firefox) and the **capture → inventory → sinks**
  pipeline. Full history in [`docs/CHANGELOG.md`](docs/CHANGELOG.md) and the git log.
