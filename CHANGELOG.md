# Changelog

All notable changes to the **Habeas** extension. The format is based on
[Keep a Changelog](https://keepachangelog.com/). Versioning is a 3-part **milestone**
(`0.2.0`) plus an optional 4th **dev suffix** (`0.2.0.1`, bumped on every change, never tagged);
only milestones are tagged and shipped to the stores. Dates are `YYYY-MM-DD`.

Update this file in the **same commit** as every version bump (see `CLAUDE.md` → Maintainer playbook).
Older detail (0.1.x public beta) lives in [`docs/CHANGELOG.md`](docs/CHANGELOG.md).

## [Unreleased]

### Added
- **Download planner** — schedule recurring deliveries from a source to a destination. Versatile
  recurrence: every day; weekly on chosen weekdays; monthly on days-of-month; the nth (or last)
  weekday of the month; the nth (or last) business day (Mon–Fri) — all at a local `HH:MM`. Runs in
  the live browser session (never stores credentials): if not signed in when it fires, it opens the
  source tab + notifies, then retries every 15 min (up to 4×) before deferring to the next
  occurrence; a browser that was closed runs the missed schedule on next start (catch-up). Uses
  `chrome.alarms` (cross-browser). New **Planner** tab in Settings.
- **AliExpress** (`aliexpress`) — order history over **Alibaba's `mtop` gateway**, via a new reusable
  **mtop transport** that also covers any Alibaba property (Taobao/Tmall/Lazada/1688…). Runs in the
  site tab and reuses the app's own live request payload (`window.__habeas_mtop`, stashed by the page
  hook) + its `lib.mtop` signing — no hardcoded payload, no forged anti-bot signature. Orders are
  extracted from the DIDA component response via `itemsFromKeys` (a `pc_om_list_order_*` key prefix,
  wildcard-tolerant to component-version bumps). Pagination bumps the page field through the seed's
  nested stringified-JSON layers (`pagePath` with `~` markers: `params~.data~.…pageIndex`). The seed is
  acquired **automatically**: the transport nudges the orders tab (scroll to the sentinel + click any
  "load more") until the app fires its own signed request — no manual scroll — preferring the POST pager
  body and falling back to the init GET payload for single-page accounts.

### Fixed
- `normalizeDate` handles `DD Mon, YYYY` (e.g. AliExpress `24 may, 2026`) — was shifting a day via the
  `Date()` fallback + UTC conversion.

## [0.2.0] — 2026-07-15

### Added
- **WebSocket transport** (`api.ws`, in-tab `makePageWs`) — the first non-HTTP source mechanism: run
  a `connect → sub → paginate → collect` loop inside the site tab so the session cookie rides the
  socket. Optional per-item detail phase.
- **Trade Republic** (`traderepublic`) — the transaction **timeline over WebSocket**, with per-item
  detail (ISIN, quantity × price) and monthly **account-statement PDF** + **transactions CSV** (async
  export **job**: `api.pdf.job` — POST start → poll status → download).
- `synthetic: "months"` now carries per-month `fromDate`/`toDate` bounds.

### Fixed
- Synthetic monthly documents (statements) are no longer marked as *existing* in **All documents**
  until actually delivered — phantom months (before the account opened) don't show a file anymore.

## [0.1.68] — 2026-07-15

### Added
- **Revolut** (`revolut`) — personal **transactions** (`to` timestamp cursor) with a per-pocket
  **account filter**, and **account statements** (PDF/CSV, async-generated then downloaded
  cross-domain from the signed Google Storage URL). Cookie session + captured `x-device-id`.
- Runtime: **currency-aware minor-unit scaling** (`minorUnits`, per ISO 4217 exponent); the
  **`cursorFromItem`** pager (next cursor = the oldest row's field); **cookie-source header
  capture/replay** (`auth.replayHeaders` on `mode:cookie`); regex **field extraction**
  (`normalize.fields`, e.g. an ISIN out of an icon path); `api.pdf.poll` (async doc generation).

## [0.1.67] — 2026-07-15

### Added
- **Openbank España** (`openbank-es`) — integrated statements, per-account **monthly movement
  statements** (PDF/XLS), and **transactions** (SCA-safe 90-day window).
- Runtime: token-only cookie policy (`auth.cookies:false`, avoids oversized-cookie HTTP 413); array
  `itemsPath` (first non-empty wins); cursor `nextIsUrl` / `stopPath` / `cursorParams`;
  `groups.derive` (split a packed field); session **keep-alive**; `keepRaw` store re-download.

### Dev tooling
- **PII/secret pre-commit guard** (`scripts/scan-pii.mjs` + hook) — blocks committing real account
  numbers, IBANs, live tokens, or raw capture dumps.

## [0.1.54] – [0.1.66] — Public beta — 2026-07-12 … 2026-07-14

Highlights (full detail in [`docs/CHANGELOG.md`](docs/CHANGELOG.md)):

- **Sources published to the community registry**: Carrefour, Dia, Hover, Decathlon, Bip&Drive,
  Leroy Merlín, WiZink, CaixaBank Consumer, IKEA, Amazon, **ING España**.
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

- Initial **Manifest V3** extension (Chrome + Firefox), the first real source (Carrefour), and the
  **capture → inventory → sinks** pipeline. Full history in [`docs/CHANGELOG.md`](docs/CHANGELOG.md)
  and the git log.
