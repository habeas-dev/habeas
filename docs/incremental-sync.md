> SUPERSEDED by [canonical-store.md](canonical-store.md) — the index/tombstone/retention model here is folded into the canonical-store design (extraction decoupled from delivery; portable store; projections).

# Incremental sync — design (NOT YET IMPLEMENTED)

> Status: **design only**, agreed 2026-07-09. Do not implement until scheduled. Captures the model for
> making heavy sources (e.g. Amazon) fast by not re-enumerating / re-delivering what's already known,
> while staying correct across multiple sinks, undelivered-old items, deletions, and document expiry.

## Problem
Some sources are slow to enumerate **all** items (Amazon pages year-by-year, then fetches per-order
detail/PDF on delivery) but could be fast if they only pulled the **latest / new** items. Re-listing the
full history on every sync is the waste.

## Core principle — separate ENUMERATION from DELIVERY
Two facts, two stores, never crossed:

- **Index — source level** (`index:<sourceId>`, storage.local): *what items exist at the source*. The
  **only** thing early-stop consults. Populated by enumeration, never by delivery. Holds no per-sink state.
  - Entry: `{ internalId, date, docAvailable?, gone?, goneReason?, goneAt? }`.
- **Ledger — (source, sink) level** (`lib/state.js` `deliveredSet`, already exists): *what each sink has
  delivered*. Per sink.

Why the split: what one sink has, another may not yet. If early-stop keyed on any sink's deliveries, the
first sink to sync would truncate enumeration and starve the others. So **early-stop is decided only
against the source index; delivery is decided per sink against its ledger.** A new sink added later gets
`index − ∅ = everything` with no re-listing.

### Derived per-sink views (computed on the fly, nothing stored redundantly)
```
pending[sink]  = index.where(!gone) − ledger[sink]      # still to deliver to this sink
archived[sink] = index.where(gone)  ∩ ledger[sink]      # captured in time → lives in the sink
missed[sink]   = index.where(gone)  − ledger[sink]      # never captured, now gone → unrecoverable for S
```
`gone` is a source-level fact; `archived`/`missed` are per-sink (= gone × ledger[sink]).

## Additions (new items) — early-stop at the HEAD
New items appear newest-first at the head, so enumeration can stop cheaply:
- Page newest-first; **stop after K consecutive items already in the index** (K>1 tolerates minor
  reordering/backfill, not just the first hit).
- **Date overlap**: re-list a small window past the mark (e.g. last 7 days) to catch a late insert dated
  before the newest-seen.
- Merge newly-seen items into the index. Incremental mode consults the index to stop; **full mode ignores
  it** and re-enumerates everything.

## Deletions — sources usually purge OLDEST-first by time
Deletions can occur anywhere, so only a full enumeration truly detects them — but time-based purging
makes most of it predictable and cheap. Three tiers:

1. **Retention window (age-based, cheap, predictive)** — `retentionDays` per source = the source's data
   horizon. Index items older than it are **`gone` (reason: retention)** without any network. Also a
   **floor on enumeration** (don't page older than retention → bounds even the first full sync).
   Generalizes the existing `list.maxAgeDays` (WiZink's 90-day SMS wall).
2. **Opportunistic tombstone on a DEFINITIVE 404/410** at delivery — the adapter must classify
   *gone* (permanent) apart from *transient* (retry) and *document-expired-but-record-exists* (see below).
   Marks `gone` (reason: 404) so no sink retries.
3. **Full-rescan reconciliation** (authoritative) — "Todo el historial" re-enumerates and marks index
   items absent from the full list as `gone` (reason: rescan). Catches non-time-based removals.

Tombstone, don't delete: keep `gone:true`+reason+`goneAt` so an enumeration glitch can't re-add it as
"new", and for audit. Delivery skips `gone` items.

### Item retention ≠ document retention
Often the record persists but its **document** expires (Carrefour: old ticket → **406**, metadata only).
Two knobs:
- `retentionDays` (item existence) → tombstone + enumeration floor.
- `documentRetentionDays` (artifact) → record stays, PDF gone past N days → deliver **metadata-only**, do
  not attempt the PDF, do NOT tombstone. This is the existing 406 case, generalized.

Retention is **soft** (grace periods, tier differences): apply a conservative **margin** before declaring
`gone` by age, and keep tiers 2 + 3 for non-temporal removals.

## No data loss — ever
Anything already delivered **survives in the sink** regardless of what the source purges. That is the
whole point of Habeas (rescue the data before the service deletes it). Deletion handling is only about
(a) not endlessly retrying a vanished, undelivered item, and (b) index hygiene — never about losing
captured data.

## UI
Two actions in the popup:
- **"Sincronizar nuevos"** — incremental (early-stop against the index), the fast default.
- **"Todo el historial"** — full rescan (ignores early-stop; reconciles deletions).

## Bounded on both ends
Head: index/early-stop (K-consecutive + date overlap). Tail: `retentionDays` floor. Between them, only
genuinely new items hit the network for enumeration, and only `pending[sink]` items incur the expensive
per-item detail/PDF fetch.

## Proposed phases (when scheduled)
1. **Index store** in `lib/state.js` (`index:<sourceId>`: read/merge/mark-gone) + per-sink derivation
   helpers (`pending`/`archived`/`missed`).
2. **Early-stop** hook in `runtime/inventory.js` pagers (incremental vs full mode; K-consecutive; date
   overlap); merge into the index.
3. **Retention**: `retentionDays` (enumeration floor + age tombstone, with margin) and
   `documentRetentionDays` (metadata-only); adapter classification of definitive-404 vs transient.
4. **UI**: "Sincronizar nuevos" / "Todo el historial" in the popup; per-sink pending/archived/missed
   reporting.

## Open items / risks
- Ordering assumption (newest-first) — verified per adapter; K-consecutive + overlap mitigate.
- Stable `internalId` required per source (Amazon orderID ✓).
- Retention values are best-effort per service; start conservative, refine from real 404/rescan signals.
