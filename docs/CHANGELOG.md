# Changelog

## 0.1.6 → 0.1.48

### New data sources
- **WiZink** — card statements (Excel and PDF) and card **movements/transactions** (current month + each past statement).
- **Bip&Drive** — toll invoices.
- **Leroy Merlín** — receipts.
- **CaixaBank Consumer** — card statements (cross-domain service, behind explicit consent).
- **IKEA** — purchases (online orders and in-store tickets) with their receipt PDFs.
- **Amazon** — order details (date, total, items, **payment method + last 4 digits**, **return/refund status and refunded amount**) and invoice PDFs.
- (These join the existing Carrefour, Dia and Decathlon sources.)

### Community sources system
- Source **versioning** with a per-source **changelog** shown in the catalog, plus one-click **Update** (and "Update all") when a newer version is available.
- **Minimum-version gating** — a source declares the minimum extension version it needs; the catalog shows "needs vX+" and disables install/update on older builds.
- **Record mode** can now infer sources from server-rendered / "AJAX-returns-HTML" pages, not just JSON APIs.

### New extraction capabilities (runtime)
- **Year-partitioned listing** that adapts to each account's real history (stops after empty years) — for services that only expose orders one year at a time.
- **Multi-period lists** (assemble a list from several period requests), **POST-body lists**, and a **date window**.
- **Two-step document resolution** (fetch a small page that links the real document, then download it — host-guarded).
- **Documents delivered inside JSON** (base64) and **absolute-URL documents**.
- **Declarative HTML → structured JSON** for pages with no embedded data.
- **Captured context values** (e.g. an account id in a request URL) and **non-JWT bearer** capture, so more services work.
- **Grouped sources** — pick which bank account/card first; files are organised under a per-account folder.
- **Learned document metadata** — real dates/amounts discovered on download are remembered and shown in later listings (useful when a site's list hides them).

### Interface
- **Live listing with progress** ("Listing documents from 2026, page 3…") that fills the table as rows arrive.
- **Working spinner + Stop button** — cancel a long list/download; whatever finished is kept.
- **Incremental saving** — each document is written and marked delivered as it downloads, so an interrupted run keeps its progress and never re-downloads.
- Rows **enrich live** as documents download (date/amount/return status fill in), and flip to "sent".

### Reliability & session capture
- Reliable **in-session authorization capture** for modern single-page apps (including banks): a **CSP-proof page hook** (runs in the page's MAIN world), **background observation** of the user's own session token, and **merging a token seen across sibling API hosts** of the same service.
- Better **re-login handling** (opens the site's sign-in page; recovers from sites that corrupt their own login cookies).
- Fixes for WiZink movements (de-duplication, payments, past months) and Amazon (correct order total for gift-card/promo-paid orders; full purchase history no longer truncated).

### Permissions
- Added **`cookies`** (only to clear a site's own corrupted login cookies) and **`webRequest`** (observation-only, to capture the user's own session token for the site they're extracting from). Both operate locally in the user's session; nothing is sent to any third party. See `docs/store-permissions.md`.

### Also
- Cross-browser packaging and CI, a public landing/architecture site, and full English + Spanish translations.
