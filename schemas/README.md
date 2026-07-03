# schemas/

Normalized output schemas, one per **domain** (not per service). Adapters map
their raw fields **into** these; consumers ingest **these**. This decoupling is
what lets many adapters feed many consumers without either side knowing about the
other.

Schemas are **versioned**: an adapter targets e.g. `receipt@1`. Breaking changes
bump the version; consumers declare which versions they accept.

Every normalized record also carries provenance metadata added by the Core:
`_source` (adapter id), `_host`, `_capturedAt`, `_schema`.

## Current schemas

- [`receipt.schema.json`](receipt.schema.json) — a purchase receipt / ticket.
- [`transaction.schema.json`](transaction.schema.json) — a financial transaction
  (card, account, investment).

## Planned

- `invoice` — utility / telco / online-order invoices.
- `energy_reading` — metered consumption.
- `investment_position` — a holding in a brokerage/pension account.
