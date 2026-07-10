# Changelog

## 0.1.53 → 0.1.54 (in progress)

### Reliability & session capture
- **Anti-bot CAPTCHA is shown to the user** — when a source's API returns a DataDome/Cloudflare/Akamai
  challenge (e.g. Leroy Merlin's order API), the extension now opens the interstitial for you to solve live
  (from the 403 body's URL, or the site) instead of failing. Auto-sync logs it as a soft "anti-bot check"
  (no error alarm) and retries after you solve it; a manual List opens the check and asks you to retry.

### Site-capture capabilities (runtime)
- **Bridge empty pages** — `list.stopAfterEmpty` lets the `page` pager skip N consecutive empty pages before
  stopping, so a year-partitioned list isn't cut short by a gap year (e.g. Leroy Merlin tickets when there
  were no purchases in 2025). Default 0 = stop at the first empty page (unchanged).
- **Top-level array lists** — a source can set `itemsPath: "$"` when the list response *is* the array (no
  wrapper object).
- **Item filter** — `list.keep: {field, values}` keeps only items whose field is in the set (e.g. keep
  `ONLINE` orders from a list that mixes online and in-store). Enables **Leroy Merlin online purchases**
  (new `Pedidos online` output) alongside the existing in-store tickets.

### Canonical store
- **No more Drive re-prompt on every Chrome open** — the Drive OAuth token is now cached in `storage.local`
  (survives browser restart) instead of `storage.session` (wiped each restart, which forced a re-auth every
  open). After one grant it's reused silently, with a `prompt=none` refresh on expiry. A store on Drive
  still prompts once when a token genuinely can't be obtained silently — but the passive popup count hint
  never pops the window. (This is the delivery token, scope `drive.file`; scraped site sessions still live
  only in memory.)
- **Drive store button reflects connection** — once you've connected Google Drive for the store, the button
  shows *Disconnect Drive* (and disconnects) instead of always offering *Connect Drive*.
- **Google Drive as a store backend** — you can now host the canonical store on Google Drive (Settings →
  where the store lives), alongside local / synced-folder / HTTP. Per-source store JSON lives under
  `Habeas/_store/<source>.json`, separate from delivered files. Uses the shipped `drive.file` OAuth client.

### Interface
- **Auto-resume listing after login** — clicking *List* on a source with no captured session opens the login
  tab and now lists **automatically** the moment your session is detected — no second click. Works whether
  the popup stays open (live) or you reopen it after logging in (a pending marker resumes it). Covers both
  bearer-token sources (Carrefour, CaixaBank — resumes when the token is captured) and cookie sources
  (WiZink — retries on the next popup open, without disturbing a half-entered login).
- **Preferred sink per source** — the sink you pick for a source is remembered and pre-selected next time,
  instead of always defaulting to the first configured sink.
- **No more `[object Object]` in the Store column** — an invoice's issuer (and any nested `{name}` field) is
  now shown by name in the list, both live and when loaded from the store.
- **Sources open on your "my purchases" page** — a source can declare `openUrl`, the exact account/purchases
  page to open in the tab (loads the SPA whose CSP allows the API host, and lands you on your data). Set for
  Carrefour, Decathlon, Hover, Dia, bip&drive, Leroy Merlin, CaixaBank Consumer, IKEA and Amazon. The URL is
  enforced to stay within the source's own registrable domain.

### Fixes
- **`Failed to fetch` on listing (e.g. Carrefour)** — the in-session request runs inside the site's tab and
  is bound by that page's CSP (`connect-src`). If the tab sat on a page that doesn't allow the API host
  (home/login vs the account SPA), the fetch failed at the network level. The runtime now retries **directly
  from the extension** on such a failure — for a CORS-open API host granted in `host_permissions` this
  succeeds and bypasses the page CSP. A real HTTP error (e.g. an anti-bot 403) is *not* retried, so
  Cloudflare-gated sources still rely on the tab; an expired token now surfaces a clean `4xx` instead.

### Interface
- **Switching source clears the list** — changing the source selector now resets the document table,
  status and buttons, so you no longer see the previous source's rows (e.g. WiZink movements lingering
  after switching to Carrefour).
- **Clearer send result** — a records-only stream (e.g. card movements, which have no document by design)
  no longer reports "0 PDF … N without PDF", which read like a failure. It now says
  "Saved to «sink»: manifest with N records". Sources that *can* produce documents still report how many
  had none ("K without a document"), and genuine failures still show "F failed".

## 0.1.52 → 0.1.53

### Fixes
- **Multi-output delivery** — a source's per-stream store key (e.g. `wizink-es:movimientos`) is used as the
  per-source manifest filename; the `:` is rejected by the File System Access API (and unsafe on Drive), so
  every no-document row (e.g. card movements, delivered as manifest records only) failed to save. The
  manifest filename is now sanitized. Statements (PDF/Excel) were unaffected.

## 0.1.48 → 0.1.52

> As above: source definitions are **data**, not bundled in the extension. These are **extension** changes —
> new capabilities that installable community sources can use.

### Canonical store (reuse extracted data across sinks & devices)
- A configured sink can act as the **canonical store** for a source: extract once, and a second sink /
  consumer / device is served the normalized records from the store instead of re-extracting. The store is
  a **role**, not a fixed place — it can live in local IndexedDB, a synced folder, HTTP, or Drive, and be
  **moved between backends** at will. Typed consumers receive a **records-only projection**. See
  `docs/canonical-store.md`.
- **Rehydration** — rebuild the store's state by importing the records a sink already holds, so switching
  device / backend doesn't force a full re-extraction. Manual mode defaults to bringing **everything**.

### Source outputs — streams × formats
- A single source can now expose **several selectable outputs**: one or more **streams** (distinct data
  sets, each with its own list/schema/fields) and, per stream, one or more **formats** (artifacts sharing
  the stream's items — e.g. a statement as **PDF or Excel**). The user picks which outputs to obtain
  (default: **all**, in manual mode); a typed sink **auto-selects** only the outputs it accepts. This
  collapses what used to be several near-duplicate sources (e.g. the three WiZink sources → one) into one.
  See the extension's `lib/outputs.js`.

## 0.1.6 → 0.1.48

> Note: source definitions are **data**, not code, and are **not bundled in the extension** (only a single
> built-in example ships). Users install source definitions from the community catalog. The changes below
> are to the **extension** — the capabilities that let it capture from more kinds of sites, plus interface,
> reliability and packaging. Services named below (WiZink, Amazon, IKEA, …) are examples of what these
> capabilities now enable; support for each ships as an installable community source, separately.

### New site-capture capabilities (runtime)
The extension can now extract from many more kinds of sites, driven entirely by declarative source data:
- **Year-partitioned listing** that adapts to each account's real history (stops after empty years) — for
  services that only expose items one year at a time (enables e.g. Amazon order history).
- **Multi-period lists** (assemble a list from several period requests), **POST-body lists**, and a
  **date window** (enables e.g. WiZink card movements).
- **Two-step document resolution** — fetch a small page that links the real document, then download it
  (host-guarded) (enables e.g. Amazon invoice PDFs).
- **Documents delivered inside JSON** (base64) and **absolute-URL documents** (enables e.g. IKEA receipts,
  CaixaBank statements).
- **Declarative HTML → structured JSON** extraction for pages with no embedded data (enables e.g. Amazon
  order details: date, total, items, payment method + last 4, return/refund status and amount).
- **Captured context values** (e.g. an account id read from a request URL) and **non-JWT bearer** capture,
  so services with opaque tokens work (enables e.g. CaixaBank Consumer).
- **Grouped sources** — pick which bank account/card first; files are organised under a per-account folder.
- **Learned document metadata** — real dates/amounts discovered on download are remembered and shown in
  later listings (useful when a site's list hides them).

### Community sources system
- Source **versioning** with a per-source **changelog** shown in the catalog, plus one-click **Update**
  (and "Update all") when a newer version is available.
- **Minimum-version gating** — a source declares the minimum extension version it needs; the catalog shows
  "needs vX+" and disables install/update on older builds.
- **Record mode** can now infer a source from server-rendered / "AJAX-returns-HTML" pages, not just JSON
  APIs, so non-technical users can author more sites.

### Interface
- **Live listing with progress** ("Listing documents from 2026, page 3…") that fills the table as rows arrive.
- **Working spinner + Stop button** — cancel a long list/download; whatever finished is kept.
- **Incremental saving** — each document is written and marked delivered as it downloads, so an interrupted
  run keeps its progress and never re-downloads.
- Rows **enrich live** as documents download (date/amount/return status fill in), and flip to "sent".

### Reliability & session capture
- Reliable **in-session authorization capture** for modern single-page apps (including banks): a
  **CSP-proof page hook** (runs in the page's MAIN world), **background observation** of the user's own
  session token, and **merging a token seen across sibling API hosts** of the same service.
- Better **re-login handling** (opens the site's sign-in page; recovers from sites that corrupt their own
  login cookies).

### Permissions
- Added **`cookies`** (only to clear a site's own corrupted login cookies) and **`webRequest`**
  (observation-only, to capture the user's own session token for the site they're extracting from). Both
  operate locally in the user's session; nothing is sent to any third party. See `docs/store-permissions.md`.

### Also
- Cross-browser packaging and CI, a public landing/architecture site, and full English + Spanish translations.
