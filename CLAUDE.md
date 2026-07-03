# Habeas — Claude Code context

## What this is

**Habeas** is an open-source (AGPL-3.0) **browser extension** that lets a user
extract their **own** personal data — receipts, invoices, card/investment
transactions — from services that hide it behind non-automatable walls
(Cloudflare, Akamai, DataDome) and offer neither an API nor an email export.

The whole design lives in **`docs/FUNCTIONAL-SPEC.md`** — read it before making
architectural decisions.

## Status

**Pre-code.** This repo is currently a skeleton + functional spec. The spec is
the source of truth; code is being scaffolded. The first real adapter (Carrefour
España) is being validated as a "dirty" userscript before the format is frozen.

## Core thesis (do not lose this)

Client-side-in-session beats server-side scraping. Because the extension runs
**inside the user's real, already-authenticated browser session**, it:

- never fights anti-bot (it inherits the user's valid Cloudflare/Akamai session),
- never stores credentials (the user logs in themselves),
- lets the user resolve MFA/OTP live.

This is the exact opposite of how Plaid/Tink/TrueLayer operate, and it's the
reason the project exists. Every design decision should preserve it.

## Architecture

- **Core** (`core/`) — the only reviewed code. Trigger, session detection,
  Capture SDK (authenticated `fetch`, DOM, pagination, PDF/blob download),
  normalization, sinks, and consent/capability enforcement.
- **Adapters** (`adapters/`) — one per service. **Mostly declarative** (YAML/JSON
  *data*, not code). Declares: host match, login signal, list/detail fetch, field
  mapping (JSONPath/CSS), dedupe key, target schema, and a **capability scope**
  (which hosts it may read, which sink it may write). Validated against
  `adapters/schema/adapter.schema.json`.
- **Schemas** (`schemas/`) — normalized output per domain (`receipt`,
  `transaction`, `invoice`…). Adapters map **into** these; consumers ingest
  **these**.
- **Consumers** (`consumers/`) — external apps that receive normalized records
  (Tiquetera = receipts, Cuéntamo = finance). **Decoupled**: the core knows
  nothing about them; they only publish an ingest endpoint + the schema they want.

## Non-negotiable rules

1. **Adapters are DATA, not code.** No `eval`, no remotely-hosted JS. Logic that
   isn't expressible declaratively uses a **bounded** set of predefined
   transforms only. (MV3 forbids remote code; this is also the security model —
   a malicious adapter cannot run arbitrary JS.)
2. **Local-first.** Data never leaves the browser unless the user explicitly
   approves a sink, per-adapter and (for sensitive data) per-send.
3. **No credential storage, ever.** Rely on the live user session.
4. **Capability scope is enforced by the Core.** An adapter reads only its
   declared hosts and writes only its declared sink, after explicit consent.
5. **Financial adapters are FIRST-PARTY ONLY.** Banking/cards/investment adapters
   are maintained & signed by the project, never accepted from the community
   unaudited, and reviewed to a higher bar.
6. **Triggers are user-initiated (or on-visit).** No background scraping with a
   stored session in the MVP — it re-triggers anti-bot/OTP and blurs the legal
   posture.

## Planned stack (not yet implemented)

- Manifest V3 extension, **Firefox-first** (Chrome Web Store may reject scraping
  extensions, especially finance-touching ones). TypeScript.
- Adapter format: YAML validated by `adapters/schema/adapter.schema.json`.
- npm package `habeas` (unscoped placeholder published); future packages under
  `@habeas/*`.
- Identity: domain `habeas.dev`, GitHub org `habeas-dev`.

## Legal posture

Framed as **GDPR Art. 20 / habeas data** — the user's right to their own data,
exercised by the user, in the user's session, via user-run open-source software.
Not a PSD2-regulated actor (no payment initiation), but data-protection duties
are maximal → local-first is reinforced for financial/health data. Per-adapter
risk is documented; ToS compliance for each service is the user's responsibility.

## Conventions

- **Language:** code, comments, docs, and commits in **English** (international
  OSS project). (Note: sibling apps Tiquetera/Cuéntamo are Spanish; Habeas is not.)
- **Adapter files:** one per service, named `<service>-<country>.yaml`
  (e.g. `carrefour-es.yaml`).
- Keep the Core small and auditable; push service-specific behavior into
  declarative adapters, never into the Core.

## First adapter reference

`adapters/carrefour-es.yaml` — Carrefour España receipts. `carrefour.es` is fully
behind Cloudflare; login uses an **email OTP**. The extension works only because
the user is already logged in (real session). Internal "Mis compras" endpoint is
still to be discovered via the userscript prototype. Target schema: `receipt`.
Consumer: Tiquetera.
