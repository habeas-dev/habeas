# Habeas

> *Habeas data* — the right to your own data, made executable.

**Habeas** is an open-source browser extension that lets you extract **your own**
personal data — receipts, invoices, card and investment transactions — from
services that lock it behind non-automatable walls (Cloudflare, Akamai, …) and
offer neither an API nor an email export.

Unlike server-side aggregators, Habeas runs **inside your own browser session**:

- No anti-bot fight — it's your browser and your IP, already trusted.
- No stored credentials — you log in yourself.
- MFA/OTP handled by you, live.
- **Local-first** — your data goes only where *you* decide.

Per-service **adapters** are mostly declarative (data, not code), so they can be
audited and contributed by the community. Output is **normalized per domain**
(receipt, transaction, invoice, …) so any consumer can ingest it.

## Status

🚧 **Early design.** This is a placeholder release to reserve the package name.
The functional specification is being drafted. Follow along at
[habeas.dev](https://habeas.dev).

## License

[AGPL-3.0-or-later](./LICENSE).
