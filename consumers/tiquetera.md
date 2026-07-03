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

- Idempotent on `receipt.externalId` per user.
- Returns per-record status (imported / duplicate / error).

## Adapters that feed Tiquetera

- `carrefour-es` — Carrefour España in-store e-tickets.
- (future) other Spanish grocers whose receipts are only available behind a
  logged-in web account.
