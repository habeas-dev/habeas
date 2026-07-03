# consumers/

A **consumer** is an external app that receives normalized records from Habeas
via a sink. Consumers are **decoupled** from the Core: they don't know about
adapters, and the Core doesn't know about them. A consumer only:

1. exposes an **ingest endpoint** that accepts a normalized schema, and
2. authenticates the user via a **per-user pairing token** (generated in the
   consumer's own settings and pasted into the Habeas extension).

This folder documents the reference consumers so their maintainers and adapter
authors agree on the contract.

## Reference consumers

- [`tiquetera.md`](tiquetera.md) — receipts (`receipt@1`). First consumer.
- **Cuéntamo** (planned) — finance (`transaction@1`, `investment_position@1`).
  Strategy: PSD2 AIS for SEPA current accounts; Habeas as a first-class source for
  what PSD2 does not cover (credit cards, investments, pensions, long history).
  Financial adapters are first-party only.

## Ingest contract (shared shape)

- `POST` with the pairing token in an `Authorization` header.
- Body: an array of normalized records for a declared schema + version.
- PDFs (when present) uploaded as multipart/attachment.
- Idempotent on the record's `externalId` (the extension also dedupes, but
  consumers must tolerate re-sends).
