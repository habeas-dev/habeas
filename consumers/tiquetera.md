# Consumer: Tiquetera

[Tiquetera](https://tiquetera.es) imports supermarket receipts and provides
purchase analytics. It is the first Habeas consumer.

## Schema

Accepts `receipt@1` (see [`../schemas/receipt.schema.json`](../schemas/receipt.schema.json)),
with the source PDF attached when available. Tiquetera already parses receipt
PDFs (its `TicketImportService`), so an attached PDF is the highest-fidelity path.

## Pairing

1. The user opens Tiquetera → Settings → "Connect Habeas".
2. Tiquetera generates a per-user **pairing token**.
3. The user pastes it into the Habeas extension when enabling a receipt adapter.

## Ingest endpoint (proposed)

```
POST /api/ingest/receipts
Authorization: Bearer <pairing-token>
Content-Type: multipart/form-data

- records: JSON array of receipt@1 objects
- files[]: the receipt PDFs referenced by records[].pdf
```

- Idempotent on `receipt.internalId` per user.
- Returns per-record status (imported / duplicate / error).

## Compatibility (categories)

Tiquetera only wants **grocery** receipts, so the Habeas HTTP sink pointing at it is
configured with `accepts: { categories: ["grocery"] }`. Habeas then (a) only offers this
destination for sources that can emit `grocery`, and (b) sends only the documents whose
`category` is `grocery` — e.g. Carrefour fuel (`REFUELING`) tickets are filtered out.

Each normalized record carries a `category` (a source classifies its documents; Carrefour:
`HYPERMARKET`→`grocery`, `REFUELING`→`fuel`) and a `record.extra` object holding the raw source
fields, so Tiquetera can reach anything the `receipt@1` shape dropped.

If Tiquetera would rather ingest one uniform shape across all grocers instead of each source's
`receipt@1`, set the sink's opt-in **`sink.normalize`** flag: Habeas then delivers the canonical
record (`id/date/amount/currency/direction/description/counterparty/category/type/account/number/source/extra`)
described in [`README.md`](README.md). Leave it off to keep the higher-fidelity `receipt@1` + PDF path.

## Adapters that feed Tiquetera

- `carrefour-es` — Carrefour España in-store e-tickets.
- (future) other Spanish grocers whose receipts are only available behind a
  logged-in web account.
