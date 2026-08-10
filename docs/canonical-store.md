# Canonical store + projections — design

> Status: **design agreed 2026-07-10**, largely implemented (portable format + merge, write-through on
> delivery, pluggable backends local/folder/drive/dropbox/webdav/s3/http, and the Settings store
> inspector; incremental early-stop against the store index is wired into the pagers). Supersedes the earlier
> `incremental-sync.md` (its index/tombstone/retention model is folded in here). Extraction is decoupled
> from delivery: a portable **canonical store** holds the user's data once; every sink is a **projection**
> of it. The store can live in any generic backend the user chooses (local or cloud) and be **moved freely**
> between them.

## Why
Extracting from a service is slow (Amazon: page-by-page history + per-order detail + invoice PDFs, worst
on the first run). Today extraction and delivery are coupled (extract → write straight to a sink). But the
data, once extracted, shouldn't have to be re-extracted — for a second sink, a second device, or a consumer
that only wants structured records. So: **extract once → canonical store → project to anything.**

## Core model
- **Extraction** (expensive, against the service) writes the **delta** (new/changed items) into the store.
- **Canonical store** — a portable, self-contained dataset (below), hosted on a user-chosen backend.
- **Projections** — every sink/consumer is a view of the store, filtered by what it accepts. A record-only
  consumer is served instantly and never triggers a document fetch.

## The store is a ROLE, not a place
A portable format hosted on a pluggable backend; **moving it between backends is a first-class operation.**

### Portable format (self-contained, merge-friendly)
Keyed by source then by `internalId` so merges are a union by id (data is append-mostly):
```
store[sourceId] = {
  meta: { source, capturedFrom, schema },
  items: {
    [internalId]: {
      record,                 // the normalized record (sinks/format.js#buildRecord output), incl. its
                              //   optional `record.extra` (every raw field the schema didn't consume — nothing lost)
      docAvailable?: bool,    // whether a document artifact exists for it
      gone?: bool, goneReason?: 'retention'|'404'|'rescan', goneAt?: ISO,  // tombstone (never hard-deleted)
      at: ISO,                // provenance: when this item was last captured/confirmed
      srcVersion?: string     // the SOURCE (adapter) version that last built/re-normalized this record — store
                              //   metadata (NOT in `record`), so a migration knows what normalization/scale each
                              //   item carries. Absent = unknown/legacy (treated as oldest). See lib/migrate.js.
    }
  }
}
```
Self-explaining → copyable wholesale between backends. Documents (PDFs/HTML) are stored **alongside by path**
in file backends, or fetched on demand; records are always cheap to carry.

### Pluggable backends
| Backend | Generic / path-addressable | Readable back | Canonical store? |
| --- | --- | --- | --- |
| `local` (IndexedDB) | yes | yes | ✅ default (single device) |
| `folder` (local-folder) | yes | yes | ✅ |
| `drive` | yes | yes | ✅ |
| `dropbox` | yes | yes | ✅ |
| `webdav` | yes | yes | ✅ |
| `s3` (AWS + S3-compatible) | yes | yes | ✅ |
| `http` **generic** (GET/PUT) | yes | yes | ✅ |
| `download` (ephemeral zip) | yes | no | ❌ projection only |
| `http` **typed consumer** (POST, `accepts`) | no | no | ❌ projection only |

Implemented backends live in `extension/src/lib/store/` (`local.js`, `folder.js`, `drive.js`,
`dropbox.js`, `webdav.js`, `s3.js`, `http.js`); `lib/store.js#makeBackend` selects one from the store
config, and `openBackend(cfg)` opens an arbitrary one without repointing the global config (used by the
inspector below).

Only a **generic + readable-back** sink can HOST the store. `download` (write-only) and **typed consumers**
(one-way, filtered listing) are **pure projections**, never the store. Each sink declares a **capability**:
`store-capable` (bidirectional, addressable) vs `consumer-only`.

A `StoreBackend` adapter implements: `load()` → full store, and `commit(mutate)` = read-merge-write with a
version/etag check + retry (only shared/cloud backends need the concurrency guard; `local` is trivial).

### Moving between backends = merge + repoint
"Move canonical store to X" = read the whole store from the current backend → **union-merge into X** (never
clobber) → switch the canonical pointer (+ optionally clear the source). Idempotent (keyed by id), so an
interrupted move is safe to re-run. Local→Drive when a 2nd computer appears; Drive→your HTTP endpoint when
you stand one up.

## Multi-device
The canonical store on a cloud backend is shared by every instance (any computer/browser). Each instance
keeps a **local mirror/cache** for speed/offline. Extract Amazon once on computer A → computer B reads the
whole history from the store, no re-extraction.

### Concurrency (shared backends only)
Records keyed by `internalId`; index is a set; tombstones for deletions. Merge = union by id; field
conflicts resolve last-write-wins (prefer the most recently captured). `commit()` does read-merge-write with
a version check and retry. `local` single-device has no concurrency.

## Projections
`project(store, sink)` = `items` where `!gone`, minus `ledger[sink]` (already delivered), minus what the
sink doesn't `accept` (category/source/artifact filter — the existing `accepts` model). A record-only
consumer gets just the records (no document fetch). A file/store sink gets records + documents at paths.

Per-sink derived views (computed, not stored): `pending[sink]`, `archived[sink]` (gone ∩ delivered),
`missed[sink]` (gone − delivered).

### CSV export (a projection, not an extra copy)
`lib/csv.js` projects records to a spreadsheet — pure, zero dependencies (RFC 4180 quoting, UTF-8 **BOM** so
Excel reads accents on a double click, separator `;` by default because that is the list separator of the
locales these files are opened in; `,` on request). Columns are a **machine contract**, so their headers are
English and untranslated: `date, description, amount, currency, balance, account, category, source, id`,
derived from what `sinks/format.js#buildRecord` emits per schema (`total`/`amount`/`netAmount` → `amount`,
`balanceAfter` → `balance`, `account`/`settlementAccount`/`group` → `account`). **Every other field of the
record follows as its own column** (`store.name`, `instrument.ticker`, `extra.<field>` …) — the store's
promise is that nothing captured is lost, so neither may the export. Tombstoned items are excluded by
default. Offered from the store inspector ("Export", per source or all of them) as
`habeas-<source>-YYYY-MM-DD.csv`.

### QIF export (the same projection, for desktop finance apps)
`lib/qif.js` writes the same records as **QIF** — the format desktop finance applications (GnuCash,
HomeBank, KMyMoney, MoneyDance, Quicken) import. They cannot RECEIVE a push: their only inlet is a file, so
without this there is no automatic path into them at all. It is a second **view**, not a second copy, and it
does not re-implement the projection: it builds on `recordToRow` (the CSV one), so both exports agree on
what the date, description and amount of a record are. Pure, zero dependencies, no BOM (several importers
read a BOM as part of the first header).

- **Two sections in one file.** Bank-like blocks under `!Type:Bank` / `!Type:CCard` / `!Type:Cash`, then
  securities under `!Type:Invst` — an investment block *cannot* sit under a bank header (there `N` is a
  cheque number, here it is the action). A QIF file is a stream of headers each governing the blocks that
  follow, so one file with both sections imports as two registers; two downloads would only mean importing
  twice. The bank header is the kind all its blocks agree on (card sources → `CCard`, a till receipt with no
  account behind it → `Cash`), else `Bank`.
- **Bank block**: `D`ate · `T`otal · `P`ayee · `M`emo · `L`(category) · `N`(number) · `^`. A negative `T` is
  money out: `direction` decides (a broker cash movement's `kind` via `SIDE_DIR`), and with neither, a
  receipt/invoice `total` is money **spent** — emitting a shop ticket as income would be a lie — while an
  already-negative total (a refund) keeps its sign.
- **Investment block**: `D` · `N` action · `Y` security · `I` price · `Q` quantity · `T` total (unsigned —
  the action carries the direction) · `O` commission · `M` · `^`. Actions map from `investment@2`'s `side`
  (and `investment@1`'s `operation`): Buy, Sell, Div, IntInc, ReinvDiv, ShrsIn, ShrsOut, StkSplit, MiscExp.
  **A record whose operation cannot be identified is left out and COUNTED** (as is a share movement with no
  quantity, or a trade with no security or no amount): a Buy imported as a Sell corrupts a portfolio, so the
  export never guesses, and the UI reports how many were dropped.
- **`Y` is a name, not an identifier**: `instrument.name`, else the ticker, else the ISIN. When the name won
  the slot the ISIN goes to the memo. **`taxWithheld` has no QIF field** and must not be smuggled into `O`
  (that would corrupt the cost basis every importer derives from it) — it is stated in the memo.
- **Dates are configurable, amounts are not.** QIF never says whether its dates are `DD/MM/YYYY` or
  `MM/DD/YYYY` (GnuCash asks the user), so the inspector offers both, day-first by default. Amounts always
  use a **dot** decimal and no thousands separator: unlike a CSV, a QIF is only ever read by another
  application, and a comma there is not a decimal mark to any importer. The `Decimals:` selector is
  CSV-only.
- **Escaping**: QIF is line-oriented and has no quoting, so a CR/LF inside a value collapses to a space —
  otherwise a stray line (or a lone `^`) would split one movement into two. QIF also has no currency or
  running-balance field: `balanceAfter` is dropped (importers recompute it) and a record in a currency other
  than the file's dominant one says so in its memo.
- Same naming as the CSV export, `habeas-<source>-YYYY-MM-DD.qif`.

## Incremental sync (the store IS the index)
- **Additions** — page newest-first, **stop after K consecutive items already in the store** (+ a small date
  overlap for late inserts). Only genuinely new items hit the network; only they incur detail/PDF fetches.
- **Deletions** — tiers: (1) **retention** (`retentionDays`: items older than the horizon are `gone`,
  cheaply, and the enumeration floor); (2) **definitive 404/410** at delivery → tombstone; (3) **full rescan**
  reconciliation. `documentRetentionDays` = the record stays but its document expired (metadata-only; the
  Carrefour 406 case).
- **No data loss** — anything already delivered survives in its sink; deletion handling only stops retrying
  vanished items and keeps the store honest.

## Phases (implementation)
1. **Store foundation** — portable format + merge (`lib/store/format.js`); `local` IndexedDB backend; Store
   API (`putItems`, `getItems`, `project`, `mergeInto`); **write-through on delivery** (every send also
   records into the store). No user-visible change yet; the store fills up.
2. **Projections / serve-from-store** — deliver to a sink/consumer FROM the store without re-extracting;
   record-only consumers skip document fetches; "sync from store" entry point.
3. **Pluggable backends + migration** — `local-folder` / `drive` / generic-`http` store backends; a
   canonical-store selector in Settings; **move/merge** between backends.
4. **Incremental sync** — early-stop against the store index (K-consecutive + date overlap); `retentionDays`
   / `documentRetentionDays`; definitive-404 tombstones; full-rescan reconciliation; per-sink
   pending/archived/missed reporting.

## Store inspector (Settings)
An in-extension **store inspector** (`ui/store-browser.js`, opened from Settings) reads any backend
directly via `openBackend(cfg)` — the configured canonical store, plain `local`, or a specific cloud
sink's store — with a **backend picker**, so a user can audit what's held and repair a backend without
repointing the global config. It can **delete** items (`deleteStoreItems(sourceId, ids)`) or empty a
source wholesale (`clearStoreSource(sourceId)` — keeps its meta). Records show their canonical projection
including `record.extra`.

## Sink capability (schema/config)
Sinks gain a declared capability: `role: 'store' | 'consumer'` (or derived from type: local/local-folder/
drive/http-generic = store-capable; download/http-typed = consumer). Only store-capable sinks are offered as
the canonical store or as a rehydration source.
