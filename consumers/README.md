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
- **Cuéntamo** (planned) — finance (`transaction@1`, `investment@1`/`investment@2`). Data contract:
  [`cuentamo-data-contract.md`](cuentamo-data-contract.md) — the field-level *what* Cuéntamo needs from a
  bank/broker source (bank movements + broker trade/cash), with a Habeas-side gap analysis (§E).
  Strategy: PSD2 AIS for SEPA current accounts; Habeas as a first-class source for
  what PSD2 does not cover (credit cards, investments, pensions, long history).
  Financial adapters are **allowed from the community**, not first-party-only: the
  same-registrable-domain guard (a captured session can only ever be replayed to the
  *same* service, cross-domain needs an explicit allowlist + consent — CLAUDE.md rule #4)
  makes credential exfiltration structurally impossible regardless of category. `first-party`
  is just an **audited trust label**, not a gate.

## Ingest contract (shared shape)

- `POST` with the pairing token in an `Authorization` header.
- Body: an array of normalized records for a declared schema + version.
- PDFs (when present) uploaded as multipart/attachment.
- Idempotent on the record's `internalId` (the extension also dedupes, but
  consumers must tolerate re-sends).

## Record shape: per-source vs. canonical (`sink.normalize`)

By default a sink delivers the source's own normalized record (schema-shaped:
`receipt@1`, `transaction@1`, …), and each record now also carries
`record.extra` — an object preserving **all raw source fields** so a consumer can
reach anything the normalized shape dropped.

For consumers that ingest from many sources (Cuéntamo, Tiquetera) and don't want to
adapt per source, set the opt-in **`sink.normalize`** flag on the sink. Habeas then
delivers a **uniform canonical record** with the same field names and types across
every source:

```
{ id, date, amount, currency, direction, description, counterparty,
  category, type, account, number, source, extra,
  valueDate?, balanceAfter? }
```

- `direction` — `debit` / `credit` sign of the movement.
- `date` — the **booked** date of the movement (a consumer maps it to its `bookedDate`).
- `account` — a **structured object** `{ iban?, last4?, groupId?, currency? }` for bank/card
  sources (Habeas derives `last4` from an IBAN or masked PAN, `groupId` from the group; see
  external-hooks `list-groups`). Falls back to the historical string when nothing structured can
  be derived; an empty string for sources with no account (receipts).
- `valueDate` / `balanceAfter` — added only when the bank source captured them.
- `number` — the document number when the source exposes it.
- `source` — the adapter id (e.g. `ing-es`).
- `extra` — the untouched raw source fields (same as `record.extra` above).

With `sink.normalize` on, a consumer writes one ingest mapping and it works for
Carrefour receipts, ING transactions and WiZink statements alike.
