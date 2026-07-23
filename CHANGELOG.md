# Changelog

All notable changes to the **Habeas** extension. The format is based on
[Keep a Changelog](https://keepachangelog.com/). Versioning is a 3-part **milestone**
(`0.2.0`) plus an optional 4th **dev suffix** (`0.2.0.1`, bumped on every change, never tagged);
only milestones are tagged and shipped to the stores. Dates are `YYYY-MM-DD`.

Update this file in the **same commit** as every version bump (see `CLAUDE.md` → Maintainer playbook).
Older detail (0.1.x public beta) lives in [`docs/CHANGELOG.md`](docs/CHANGELOG.md).

## [Unreleased]

### Added
- **Experimental (beta) sources can be published and tested** (`registry`, `ui/marketplace.*`, sources catalog).
  A source drafted but not yet verified against a real account (e.g. DeGiro, derived from woob's endpoint map)
  can now ship flagged `beta: true` instead of being hidden — otherwise nobody with the account could ever test
  it. The catalog carries the flag (`build-index.mjs`), and the marketplace shows beta sources with an
  "experimental" pill, a toggle to hide them, and a confirm-on-install warning that they're unverified. First one
  in: **DeGiro** (`degiro`, beta), credited to woob's DeGiro module under AGPL.

## [0.7.0] — 2026-07-22

### Added
- **"Recover data from destination"** (`background.js`, `sinks/sinks.js`, `ui/archive.js`). A source whose
  listing exposes only a coarse stub (Amazon: a year, no amount) determined each document's real date **and
  amount and details** at download time, but a past build wrote them only to the delivered files + the
  destination's per-source manifest — not back to the store record. New Refresh-menu action reads that manifest
  (which carries the full delivered record) and write-throughs every **richer** record (a precise date, a real
  amount, return/refund/payment, or line items) **without re-fetching from the source** — recovering the whole
  record, not just the date; the store's shard layer then moves each document to its month shard.
  `readSinkRecords` now also reads Dropbox/WebDAV/S3 manifests. (Going forward, `adoptRealDate` already saves the
  real date to the store at download.) It reports **live progress** — reading the manifest, then a
  `recovered N/total` counter as it write-throughs in chunks — and patches the open Archive's cards as each
  chunk lands.
- **Group-header checkboxes + long-press to select in the Archive** (`ui/archive.js`, `ui/archive.html`). In
  selection mode each month/category/store header shows a checkbox that selects or deselects that whole group at
  once (with an on / partial / none state that tracks individual toggles). And **long-pressing any document**
  enters selection mode and pre-selects it (touch-friendly; the "Select" button still works).
- **The Archive paints from a local cache on open** (`ui/archive.js`). Basic index metadata — the existing
  sources, each source's document count + last date, and its accounts (groups) — is cached in `storage.local`
  (`habeas:archive-cache`) and rendered instantly on open, so the Archive is never blank/throbbing while a
  (possibly cloud) store is read. It then reconciles against the store and hydrates live counts in the
  background, refreshing the cache. `buildIndex` seeds counts from the cache too (known sources show real numbers,
  no throbber); `accountsOf` falls back to the cached accounts so the account tree shows instantly on open.
- **Inline document preview in the Archive** (`ui/archive.js`, `ui/archive.html`). Previewable delivered files
  (PDF, HTML, images) now open in an overlay inside the Archive — a 👁 Preview action in the document drawer —
  instead of a separate tab. It fetches the file's blob from its destination via the same `retrieveDelivered`
  the full-tab viewer uses (PDF/HTML in an iframe, images in an `<img>`), with "Open in a tab" and Esc-to-close.
  Non-previewable types (Excel, JSON…) still open in the full-tab viewer.
- **Live per-document progress in the Archive + a Stop button** (`background.js`, `ui/archive.js`,
  `ui/archive.html`). Save/Send/Re-download now stream each document to the Archive view as it downloads: the
  background emits a `habeas:doc-progress` signal per document (the real date/amount as it's fetched, then a
  "saved" flip after delivery), and the open Archive patches just that card — the view fills in as work runs, not
  only at the end. A red **Detener** button appears while an operation is in flight and aborts it cleanly (a global
  `AbortController` + `habeas:stop`, threaded through `runRoute`/`sendStoredDocs`/`listInventory` and Sync-all).
  The status line now shows a live `N/total · name` counter for long sources and mirrors its text into the
  element title, so a truncated message is readable in full on hover.

- **The document drawer shows the order breakdown** (`ui/archive.js`, `lib/detailview.js`, `lib/retrieve.js`).
  Opening a document in the Archive now fetches its stored JSON detail (the `data` artifact saved next to the
  file — e.g. an Amazon order's line items, unit prices, payment method + last4, return/refund) back from a
  readable destination and renders it: a line-item table plus payment/return/refund rows. Fetched on demand, so
  the full breakdown shows even though the compact store record only keeps date/total — nothing has to be
  re-downloaded. New pure `lib/detailview.js#detailView` (unit-tested); `retrieveDelivered` gained an `only`
  option to fetch just the JSON (no wasteful PDF fallback). No-ops silently for sources with no JSON detail.

### Fixed
- **Opening a big source in the Archive is fast again + renders progressively** (`lib/store/sharded.js`,
  `ui/archive.js`). Month-sharding made loading a source with years of history slow — `loadSource` read its
  dozens of shards **sequentially** (one cloud round-trip each). Shards are now read **concurrently** (bounded
  fan-out of 8). And the document list renders **progressively**: the newest few month/category groups paint
  immediately, then more append as a sentinel scrolls into view (IntersectionObserver), instead of building
  thousands of cards up front and showing them all at once.
- **Long operations retry instead of failing when the service worker is recycled** (`ui/archive.js`,
  `background.js`). MV3 recycles the background service worker mid-operation, closing the message channel before
  the response arrives ("A listener indicated an asynchronous response by returning true, but the message channel
  closed before a response was received"). Save/Send/Recover-data/Sync-all now **re-send the message a few times**
  on that transient error (showing "Connection dropped — retrying (n/total)…") — safe because a fresh attempt
  aborts any lingering prior one and resumes from the per-chunk delivery ledger. Plus a **keep-alive heartbeat**
  (a periodic extension-API call while an op runs) resets the worker's idle timer so it's recycled far less often.
- **Cloud store writes/reads from the background actually work now (root cause of several store bugs)**
  (`lib/store.js`). `makeBackend` resolved non-`local` backends with a dynamic `import()`, which is **disallowed
  in an MV3 service worker** ("import() is disallowed on ServiceWorkerGlobalScope"). So every canonical-store
  operation from the background — `recordDelivered` write-through on download, `listSources`, the new date
  reconcile — silently failed for a Dropbox/Drive/WebDAV/S3 store. This is why a download never wrote the real
  date back to the store, and why the store looked unlistable from the service worker. All backends are now
  imported **statically**.
- **The "Stop" button only shows while something is running** (`ui/archive.html`). The `.abar button` rule set
  `display:inline-flex`, which overrode the `hidden` attribute, so the red Stop button was always visible. Added
  the `.abar button[hidden]{display:none}` override (same pattern already used for menus/overlays).
- **Amazon documents no longer all land dateless in the store** (`background.js`, `lib/store/sharded.js`). Amazon
  exposes only a YEAR in its listing; the real date rides the per-document JSON detail. That detail is only
  fetched when the SINK accepts the `data` artifact, so a PDF-only destination left every record year-only — and
  the month-sharded store then bucketed them all as `_undated`. Now (1) the real date is adopted for the store
  independently of delivery (`adoptRealDate` fetches the detail just for the date when it's still year-only), (2)
  a year-only date buckets by **year** (a year is a date), not `_undated`, and (3) `appendItems` **moves** a
  document to its month shard once its date becomes precise, dropping the stale copy from the coarser (year /
  `_undated`) shard — no duplicates. **`loadSource` also self-heals**: entries an older build left in the wrong
  shard (e.g. a whole Amazon history dumped in `_undated`) are re-split into the right shards the next time the
  Archive is opened. Covered by `test/sharded-store.test.mjs`.
- **Large downloads checkpoint incrementally — no more "500 downloaded, metadata lost"** (`background.js`). A
  long download (`runRoute` Save / Sync-all, `sendStoredDocs` Send/Re-download) used to fetch every document,
  then write the files + delivery ledger + canonical-store records **once at the very end** — so any interruption
  (Stop, the service worker recycling, the browser closing, a failed final write) lost the whole batch's
  metadata. It now flushes every 25 documents (files + ledger + store records), so an interruption loses at most
  the in-flight chunk; already-checkpointed documents are durable. `writeToSink`/`recordDelivered`/`markDelivered`
  all read-merge-write, so repeated flushes accumulate safely. The ephemeral `download` (ZIP) sink stays
  single-shot (one flush = one ZIP). Covered by `test/checkpoint.test.mjs`.
- **Preview renders the file instead of downloading it** (`ui/archive.js`, `ui/docview.js`). A sink hands the
  file back as `application/octet-stream` (Dropbox's download endpoint sets that Content-Type), so the preview
  `<iframe>`/`<img>` downloaded the blob rather than showing it. Both viewers now re-wrap the retrieved blob with
  the MIME its extension implies (`application/pdf`, `text/html`, `image/*`) before the object URL, so HTML and
  images render inline. **PDFs**: a `blob:` PDF inside an `<iframe>` on an MV3 extension page is still downloaded
  by Chrome (and MV3 forbids `blob:` in `object-src`, so a plugin `<embed>` isn't allowed) — so the full-tab
  viewer now renders a PDF via a **top-level navigation** of its tab, which Chrome's built-in viewer handles
  reliably. "Open in a tab" from the Archive preview is the dependable PDF path.
- **Sending/re-downloading hand-picked documents works with a cloud-backed archive** (`background.js`,
  `ui/archive.js`, `ui/popup.js`). The Archive's Send/Re-download passed only document ids, and the background then
  re-read the canonical store to find them — but a **Dropbox/folder-backed archive isn't listable from the service
  worker** the way it is from a page (`listSources()` returned nothing there), so every send said "nothing sent".
  The Archive now passes the picked documents' **records** (which the page already read) to the background, which
  just fetches files + delivers — no store re-read. Also: `acceptsDoc` reads `doc.category`, so the built doc now
  copies `category` up (with a fallback to the source's default) — a category-filtered sink no longer rejects
  everything (also fixed in the popup's `docsFromStore`). Covered by `test/format.test.mjs`.
- **The real document date is now saved to the Archive on download** (`sinks/format.js`, `background.js`,
  `ui/popup.js`). Sources whose list only exposes a year (Amazon) carry the real date in a JSON detail fetched at
  download time; the popup's send adopted it but the Archive's Save (`runRoute`) and Send (`sendStoredDocs`) did
  not — so Amazon documents were stored as `YYYY-01-01`. Extracted the adoption into a shared
  `format.js#adoptDetailMeta(d, arts)` and applied it in all three download paths, so the record, file names, the
  canonical store, and the docMeta overlay all get the real date. (Use Save → "Re-download from site" to fix
  already-stored documents.) Covered by `test/format.test.mjs`.
- **Source cards in the Archive index stack name + count again** (`ui/archive.html`). `.sc-m` was an inline span,
  so a source's name and its "N documents · date" ran together on one line; it's now a flex column.
- **Orphan sources are hidden and auto-cleaned** (`ui/archive.js`, `lib/store.js`). Store keys left behind by a
  removed/renamed source (e.g. `raisin-es` → `raisin`) — a base with stored data but no installed adapter and no
  configured datasource — no longer render in the Archive, and their store data is auto-deleted on load (new
  `store.js#deleteSource`; the local backend removes the key, cloud backends empty it).

### Changed
- **The canonical store is now month-sharded per source, across every backend** (`lib/store/sharded.js`,
  `lib/store.js`, `lib/store/{local,folder}.js`, `sinks/{dropbox,drive,sinks}.js`). One ever-growing
  `<id>.json` per source became month shards — `<id>/<YYYY-MM>.json` (+ `_undated.json`) with a small
  `_meta.json` holding **only the source's own metadata** (no derived/cached data — the "Load from store" badge
  asks a cheap existence probe, `hasItems`, over the shard listing). Motivation: a source with thousands of
  documents (Amazon) had a large JSON that **every checkpoint rewrote in full** (O(n²) bandwidth — badly
  amplified by the new per-25-doc checkpointing). Now a write routes entries to their month shards and rewrites
  **only those** (a recent-orders sync touches one or two tiny files). A generic sharding layer sits over
  **semantic shard ops** (a `pathPrim` adapter maps them to files for the path backends), so all six backends
  adopt it — **local (IndexedDB), folder, Dropbox, WebDAV, S3, and Google Drive**. **Transparent**: `loadSource`
  reassembles the shards into the same `{ meta, items }` shape, so `format.js`, the Archive and consumers are
  untouched. A pre-shard single blob is **auto-reformatted into shards on load** (one-time; passive badge reads
  never write). Covered by `test/sharded-store.test.mjs` (+ updated backend round-trip tests).
- **Clearer document status labels: "Pending" / "Saved"** (`_locales`). The Archive card status "Only in your
  archive" vs "Saved" was confusing when your destination *is* your archive (e.g. Dropbox as both store and
  sink) — it read as two places when the real difference is **data vs file**: your archive holds the data
  (record), a destination holds the file. Renamed to **Pending** (we have the data; the file isn't saved yet)
  and **Saved** (the file is saved to your destination), with tooltips and the legend reworded to match.
- **Settings page reorganized around plain-language user journeys** (`ui/options.html`, `ui/options.js`). The dense
  6-tab admin layout is gone; Settings now has a left rail (like the Archive) with sections framed for a
  non-technical user: **Inicio** (a "your setup at a glance" overview + a first-run 1·2·3 checklist), **Servicios**
  (connect services to recover documents; source authoring tucked under "advanced"), **Dónde se guardan** (the
  canonical store — split out from Destinations so "your archive" and "sending copies" stop being conflated),
  **Automático** (auto-sync + scheduled deliveries merged), **Privacidad** (a "no passwords, in your session,
  open source" reassurance + the site-integration grants), and **Avanzado** (destinations/sinks + contributions).
  All the existing logic is reused unchanged — element ids preserved; only the IA, copy, navigation, and visual
  shell changed. New plain-language copy in en/es.

## [0.6.0] — 2026-07-21

### Added
- **First-run assistant for the canonical store** (`ui/archive.js`, `lib/storesetup.js`). While the store is still
  the default per-browser backend, the Archive index shows a small assistant that explains what "your archive" is,
  recommends keeping it in the cloud for multi-device access, and moves it there in one click. It can move the
  archive to **any** backend and reuses the existing tested primitives via a thin shared abstraction
  (`lib/storesetup.js` → `moveStoreTo` / `driveSignIn` / `putHandle`) — no new store logic. **Dropbox is the
  recommended cloud store** (Google Drive's app-scoped `drive.file` access is awkward for this); the assistant
  offers one-click move to any already-configured cloud sink (Dropbox / WebDAV / S3), Google Drive, a local folder
  (Chromium), or dismiss. **Any destination can be created from the assistant itself** — "Add another destination…"
  (and the Dropbox setup button) open the full add-a-sink form in a modal, then connect + move the archive there.
- **Shared add-a-destination form** (`ui/sinkform.js`). The per-type sink fields + build/connect logic were extracted
  from `options.js` into one module reused by both Settings and the first-run assistant — no duplication. The
  store-move core is covered by `test/store.test.mjs`.
- **Archive — per-source "Refresh"** (`ui/archive.js`, `background.js`). A ↻ Refresh button on each source lists
  every output and writes the new documents straight into the local store — no destination required. It reuses the
  auto/manual list pipeline (incremental: seeds known ids so a refresh only pulls what's new) and honors the same
  no-session / anti-bot-challenge contract (opens the site to sign in or solve the check, then the user retries).
  This makes the Archive self-sufficient: browse and pull fresh documents in place before deciding where to send.
  It's the Archive equivalent of the old "List documents". A **caret** on the button opens the two alternative
  modes the old UI had: **Update full history** (re-scan the whole history, not just the delta) and **Load from
  store** (re-read the local store with no network request).
- **Archive — send hand-picked documents** (`ui/archive.js`, `background.js` `habeas:send` → `sendStoredDocs`).
  Selection mode now offers "Send to <destination>" for every compatible sink: the chosen documents are delivered
  from the store (each record's manifest, plus its file re-fetched when the source can still produce it).
- **Archive — account management** (`ui/archive.js`). Grouped (bank) sources get an 👤 Accounts button that opens
  the account picker in place, so you choose which accounts a source tracks without the popup.
- **Archive — a complete source manager.** The index now lists every enabled, installed source, not only those
  with stored documents — so a freshly-installed source appears and can be Refreshed to pull its first documents.
- **Archive — "No account" bucket** (`ui/archive.js`). In a grouped source, documents with no associated account
  are reachable via a "No account" node in the account tree (they were hidden by the multi-account gate before).
- **Archive — "Re-download from site" for the selection**, as a caret next to the selection bar's "Send to
  <destination>" (mirrors the Save button's dropdown). Re-fetches the picked documents' files + details fresh
  from the site — `habeas:send` `force` → `sendStoredDocs` always opens the site tab — so, e.g., an Amazon
  document stored with the wrong date is regenerated with the real one.
- **Archive — select all / none** in selection mode, and a **Save → "Re-download from site"** dropdown that
  re-fetches and re-delivers even already-delivered documents (`habeas:deliver` `force` → `runRoute` delivers all
  listed docs, not just undelivered), mirroring the classic "Re-download from site" toggle.

### Changed
- **Archive Refresh calls the SAME list core as the classic "List documents"** (`runtime/lister.js`,
  `ui/archive.js`, `ui/popup.js`). The listing logic was extracted into one shared `listSourceInto(adapter, opts)`
  that both the popup's `onList` and the Archive's Refresh now call, running in the page (not a background
  reimplementation): saved account allow-list or the transient account picker (`pickGroup`), incremental unless a
  full re-scan, write-through to the store. This replaces the earlier background `habeas:list`/`listSourceIntoStore`
  parallel path (removed) that behaved differently and could list nothing. Covered by `test/lister.test.mjs`.
- **Popup launcher: Settings + status line left the header; sources sort by recency.** The header now holds only
  the brand and Sync-all; Settings moved to the footer and the status line sits below the hero. Source chips are
  ordered by most recent news first — the last activity-log entry that brought new documents, then any activity,
  then alphabetical (was arbitrary insertion order).
- **Popup is a pure launcher; Advanced tools + Activity log are their own tabs.** The popup now shows only the
  quick hero (a chip per source + "Open the Archive"), Sync-all, and links to Advanced tools / Settings — plus the
  last status message in the topbar (fed live from the background's `habeas:status`). The classic Sources/Documents
  UI moved out of the popup into its own page (`advanced.html`, driven by the existing `popup.js`), and the
  activity log into its own page (`activity.html`, grouped by day). A 🗒️ logs button opens the activity tab from
  the Archive and the Advanced-tools window (never from the popup). New `launcher.js` drives the slim popup.
- **Archive — multi-account sources wait for an account pick** (`ui/archive.js`). Selecting a bank/multi-account
  source no longer mixes every account's documents together; it shows a prompt to choose an account in the tree
  first, then lists that account's documents. Single-account sources are unaffected. The source-level controls
  (Refresh, Accounts) stay available on that prompt.

### Fixed
- **Archive Refresh/Save/Send now open the source tab when needed.** They used `resolveSiteFetch`, which returns
  null when no tab sits on the source's origin — so Refresh (and "Update full history") listed nothing and Save/Send
  couldn't fetch, while the old "List documents" worked because it used `ensureSiteFetch({open:true})`. Now Refresh
  (via the shared list core, run in the page) and the interactive `runRoute` open the site tab if none exists
  (`sendStoredDocs` opens it only when the delivery actually needs to fetch files), matching the old behavior: the
  page-context fetch inherits the session, and a signed-out user lands on the login page.
- **Refreshing/saving/sending one source no longer reloads the whole tree** (`ui/archive.js`). A single-source
  action used to call `buildIndex()` + `hydrateIndex()`, re-counting *every* source (throbbers flashing across the
  entire tree). A new `reloadCurrent()` recomputes only the current source's documents and its own tree count/date;
  the full re-hydrate stays reserved for Sync-all and reinstalls.
- **The toolbar button opens the floating popup again** (`manifest.json`, `background.js`). The `action` had lost
  its `default_popup`, and a `chrome.action.onClicked` listener was opening `popup.html` in a full tab instead.
  Restored `default_popup: src/ui/popup.html` and removed the listener — clicking Habeas shows the launcher popup.
- **`runRoute` sync status line had its placeholders swapped** (`background.js`) — the transient "…: N new synced"
  toast showed the count and source name in the wrong slots. Now renders `<source>: <N> new synced`.

### Fixed
- **An ungrouped source can label a row's account** (`sinks/format.js`). A flat list where each row *is* its own
  account (a deposit) can map a `group` field directly; `buildRecord` uses it when there's no grouped `_group`,
  so those rows no longer show a blank "Account". Ungrouped rows without a `group` field stay byte-identical.
- **Group (account) fields can be templates, so account names are readable.** `listGroups` mapped each account
  field with a plain path lookup, so a `groups.fields.name` template like `"Cuenta {product.bank.name}"` didn't
  resolve — the account picker and the "Account" column fell back to a raw id (`OMA_121_609_733_983`). It now
  resolves group fields through the same template engine as record fields (paths, templates, and the new
  `:num`/`:duration`/`:date` formats), so both show the readable name. Re-list a source to refresh already-stored
  labels.
- **List query params now resolve `{ctx.*}`** (`runtime/inventory.js#fetchList`). A captured context id belongs
  in a query filter, not only in the path — but `fetchList` only templated `{group.*}` + dates, so a param like
  `customer_id={ctx.customer_id}` was sent **literally** and the upstream rejected it (Raisin's `dbff`/`dbs`
  returned 403 on `depositos`/`ahorro`/`documentos`). Now list path + params run through `fillCtx` too (a no-op
  for any string without a `{ctx.*}` token). Regression-tested; the enhanced replay harness also flags any
  unresolved `{ctx.*}`/`{group.*}`/date template in a built request.
- **`pdf.params` are appended to the document fetch** (`runtime/inventory.js#fetchPdf`). The document URL was
  built from `pdf.path` only, ignoring `pdf.params` — so Raisin's `dds` document was fetched without the
  required `?preview=true`. Now the declared params (templated like the path) ride the document request.
- **Reinstalling a source now replaces every in-memory copy.** `saveSource`/`removeSource` bump a
  `habeas:sources-rev` signal, and the popup + archive listen for it and re-fetch `getAdapters()` (the
  background already re-synced on `habeas:sources`). Before, a page that had cached the adapter at load kept
  running the OLD definition after a reinstall — so a fixed source (e.g. a corrected query filter) appeared to
  have no effect until the page was reloaded. (This cost several rounds on Raisin.)
- **A problem report shows the version of the source that is ACTUALLY installed**, read from the stored adapter
  (`ui/options.js`), plus "(installed)" / "(NOT installed)". The earlier fallback to the thread's *offered*
  latest version masked "you're still running the old source" — the report read v0.8 while the running adapter
  was v0.7.
- **A guided re-recording reads clearly in the conversation.** The message that accompanies an attached
  recording is now a plain "📎 recording sent" note instead of echoing the team's instruction verbatim (which
  looked like a duplicate of the team's message).

### Fixed
- **Request-context reports never reveal a private id.** An earlier iteration showed a query value verbatim for
  an allowlist of "safe" param names — which leaked a private id when the value was e.g.
  `filter=customerId eq BAC_… & type eq TA_INTERNAL`, and the request path likewise showed account ids. Both the
  path and every query value now pass through id/PII redaction (`lib/diag.js#redactReqVal`): ids (`BAC_/TRA_`
  style, IBAN, email, JWT, long numerics) become `[id]`/`[iban]`/… while structure and enums stay readable
  (`filter=customerId eq [id] & type eq TA_INTERNAL`). The redacted structure is still enough to author from —
  a private id is always templated from captured context (`{ctx.*}`), never needed verbatim.

### Changed
- **The Archive tree drops the "Everything" root and the "All accounts" subnode** (`ui/archive.js`). Mixing
  documents across different sources isn't meaningful, so the tree is just the list of sources; a source node
  is itself its "all accounts" view (clicking it clears any account filter), and the account subtree lists only
  the real accounts. The brand returns to the source index.
- **The account picker enumerates every grouped stream of a source** (`ui/popup.js` + `ui/accountpicker.js`).
  A multi-product source keeps its accounts in several streams (Raisin: the current account in one, savings +
  deposits in another) — the picker used to show only the first stream's accounts. It now enumerates them all
  and merges by id, so every product appears. A single stream failing doesn't kill the picker.
- **The Archive loads progressively, with throbbers.** It used to load every source in full before painting
  anything ("takes forever"). Now it paints the source index instantly and **hydrates each source's count + last
  activity in the background** (a spinner on each card/rail node until its number arrives), yielding between
  sources so the page stays responsive. Opening a source shows a **loading spinner** immediately, and its
  documents render **group-by-group in batches** so even a source with thousands of documents paints
  progressively instead of freezing the tab.

### Added
- **`{i18n:key}` templating token — per-locale label words in a source** (`runtime/inventory.js`). A source can
  carry an `i18n` dictionary (`{ deposit: {en, es, de, …}, account: {…} }`) and a field/label template can
  reference `{i18n:deposit}`, resolved to the browser language (exact-locale → language → English → any). This
  lets a multi-market source translate a fixed word the API only returns as an enum — Raisin's product type now
  reads `Depósito`/`Deposit`/`Festgeld`/… per the user's language (markets en/es/de/fr/nl), composed with the
  browser-locale number and duration (`2,45% 6 meses` / `2.45% 6 months` / …).
- **`{locale}` templating token for multi-market sources** (`runtime/inventory.js`: `fillLocale`). A path or
  query param can carry `{locale}` (the browser locale, BCP-47, e.g. `es-ES`) or `{locale:lower}` (`es-es`), so
  one source serves every market a platform runs in when the API is shared and only the response-language param
  differs. (Raisin's `api2.weltsparen.de` backend is common across countries; the source is now `raisin`, not
  `raisin-es`, and its `locale` param follows the browser instead of a hardcoded `es-ES`.)
- **Browser-locale value formatting in field templates** (`runtime/inventory.js`: `fmtValue`). A field/label
  template can now format a value with `{path:num}` (a number in the UI locale — `2.45` → `2,45` in Spanish),
  `{path:pct}` (a fraction ×100), `{path:duration}` (`{period,units}` → `6 meses` / `1 año`, auto-pluralized via
  `Intl`), and `{path:date}` (ISO `YYYY-MM-DD`). Only a known format keyword after `:` is treated as a format, so
  plain dotted paths are unaffected. Lets a source read like the service's own UI — e.g. Raisin deposits now
  show `Depósito Banca Progetto 2,45% TAE 6 meses - 2024-03-22` and savings `Cuenta Nordax Bank AB publ`.
- **A list/account enumeration can span several endpoints** (`runtime/inventory.js`: `api.list.paths[]` and
  `api.groups.paths[]`). When a source's items live behind more than one URL — Raisin keeps deposits in BOTH
  `/dashboard/active` and `/dashboard/inactive` — the runtime fetches each and merges. Without it, inactive
  (cancelled/matured) deposits and all of their documents were silently missed. Validation accepts `paths[]` as
  an alternative to a single `path`; regression-tested.
- **Save to a destination from the Archive** (`archive.js` + a new `habeas:deliver` background message reusing
  `runRoute`). A source's document view now has a **"Save to …"** control listing the compatible software
  destinations (Drive / HTTP / WebDAV / S3 / Dropbox that accept the source); clicking it delivers every
  not-yet-saved document of that source to that destination through the full, tested pipeline (session → list
  new → fetch → write → ledger + store), respecting the account filter. Statuses on the cards update
  afterwards. Honest when there's no live session ("sign in to the source and try again") — no silent failure.
- **A redesigned popup landing** (`ui/popup.*`): a friendly **quick hero** at the top frames the popup as the
  fast lane to the visual Archive — a "$N sources in your archive" line, per-source chips that deep-link
  straight into that source in the Archive, and a prominent "Open full archive" button. Cheap: it reads only
  the store's source keys, so the popup stays snappy. The existing power controls are unchanged below it.
- **A visual document archive** (`ui/archive.html` / `archive.js`), opened from the popup's Documents tab
  ("Open full archive"). A full-tab, friendly view of everything recovered — the counterpart to the popup's
  quick "sync + see new". Left rail is a **source → account tree**; the root "Everything" is an **index of
  sources** (counts + last activity). A source opens its documents as **cards grouped by month** (banks, with a
  running net) or **by category / store** (everything else) — switchable — each card carrying a colour-coded
  category tile+icon, title, date, signed amount, and a saved/in-archive status. Clicking a card opens a
  **details drawer** with the record and clear actions: **open each delivered file** by destination (real, via
  `docview.html`), an honest note for record-only movements or not-yet-saved documents, and a raw view. A
  **selection mode** enables batch open. Wired entirely to the real canonical store, delivery ledger, account
  filter, and adapter metadata; nothing hardcoded. Reuses `theme.css` (palette + fonts), theme-aware, and is
  additive — the popup and options pages are unchanged. (First step of the UI redesign; popup quick-view and
  in-archive send come next.)
- **Group-request query params support `{ctx.*}` templating** (`runtime/inventory.js`) — a captured context id
  (e.g. a customerId) can be injected into a list filter, not just the path. A no-op for any param without a
  `{ctx.*}` token, so existing sources are unaffected.
- **Every problem report is stamped with the Habeas build + installed source version** (`ui/options.js`). The
  team section of a report now always opens with `Habeas <version> · source <id> v<source-version>` — sent even
  when there's no failure trace — so a result is never ambiguous about WHICH extension build and WHICH source
  version produced it (both shuffle a lot during authoring). Shown in the "See what's sent" preview too.
- **A report shows the actual request context — SPA vs our replay** (`lib/diag.js#pushReqCtx`/`formatReqCtx`,
  `background.js`). The webRequest observer already sees the FULL headers a request carried, including the
  browser-set `Origin`/`Referer`/`Cookie` the in-page sample hook drops — and it fires on BOTH the site's own
  request AND our replay fetch to the same URL. "Report a problem" now includes a **redacted** context line per
  observed request (header *names* only, host-level origin/referer, cookie *presence*, and the HTTP status), so
  the team can diff a **working request (HTTP 200)** against a **failing one (HTTP 401)** — "the SPA's
  `/accounts` carried a cookie + these headers; our 401'd one didn't." Each header is shown as
  **`name=valuefingerprint`** (a short, non-reversible FNV-1a hash of its value — sensitive headers
  `cookie`/`authorization` are never hashed), so two requests are diffed **value-by-value, not just by name**:
  a header that shares a name but differs in value (e.g. `sec-fetch-site: cross-site` vs `same-origin`) shows a
  different fingerprint. Each line also shows the **query string** (safe filter/paging/date param names verbatim
  — e.g. `filter=all` vs the SPA's real value — everything else hashed), the **raw header order** (a WAF can
  reject on order-fingerprint alone), and a **fingerprint of the whole `Authorization` value** (`token(… fp …)`)
  to confirm two requests carry a byte-identical token+scheme, not just the same `iat`. Each line also shows the
  sent bearer's
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
