# Contributing to Habeas

Thanks for helping people reclaim their own data. The most valuable contribution
is usually a **new adapter**.

## Contributing an adapter

Adapters (aka **sources**) are **declarative data, not code** — plain JS objects interpreted by a
fixed runtime (`extension/src/runtime/inventory.js`), never `eval`'d. There are **three ways** to add
one — see **[docs/ADDING-SOURCES.md](docs/ADDING-SOURCES.md)** for the overview:

- 🔒 **Local only** — record it in the extension, keep it private (below) — or **Share** it later if you want.
- 🤝 **Assisted** — record it and let the Habeas team finish & publish it: **[docs/ASSISTED-AUTHORING.md](docs/ASSISTED-AUTHORING.md)**.
- 🛠️ **Advanced (AI + proxy)** — capture with mitmproxy and hand-author with an AI, for *any* service:
  **[docs/AUTHORING-SOURCES.md](docs/AUTHORING-SOURCES.md)** (the complete adapter reference lives here).

The easiest way is **record mode** inside the extension (no hand-writing required):

1. On a device logged in to the service, open the extension → **Create a source**
   (record mode) and browse your data so Habeas observes the real API calls.
2. **Analyze** → review the auto-drafted host match, login signal, list/detail/PDF
   fetch, pagination, field mapping, dedupe key, target schema and category in the
   visual mapper.
3. **Test** → confirm sample docs come back; fix the mapping / schema / category.
   Every source is validated by `extension/src/adapters/validate.js` (schema +
   same-registrable-domain guard) before it can be used.
4. Map your fields into an existing normalized schema (`receipt`, `invoice`,
   `transaction`, `investment`); open an issue first if you genuinely need a new one.
5. **Save**, then **Share** → opens a prefilled PR to
   [`habeas-dev/sources`](https://github.com/habeas-dev/sources), describing the
   service, what data it exposes, and any legal/ToS caveats you're aware of. Only
   real, API-verified sources are published (never invented endpoints/fields).

### Rules for adapters

- **No code.** If your service needs logic that the declarative format + the
  predefined transforms can't express, open an issue — we extend the format for
  everyone rather than allowing arbitrary JS.
- **Least privilege.** Touch the fewest hosts that works, and never list a host in
  `crossDomainHosts` unless the service genuinely spans registrable domains.
- **Same registrable domain (eTLD+1) is the hard boundary.** Every host your
  adapter reads from or replays the session to must share one registrable domain.
  If a service legitimately spans domains (e.g. login on `bank.es`, API on
  `bankapi.com`), list the extra ones in `crossDomainHosts` — this is allowed but
  triggers a prominent off-site consent screen for the user. No wildcards.
- **Financial adapters are welcome from the community** under that guard: a source
  only *describes* how a service structures the user's own data, and the domain
  boundary prevents credential exfiltration. They carry the `community` trust
  label; project-maintained ones carry `first-party` (audited to a higher bar).

## Principles this project will not compromise on

- Local-first: nothing leaves the browser without explicit user consent.
- No credential storage.
- The Core stays small and auditable; complexity lives in declarative adapters.

See `CLAUDE.md` and `docs/FUNCTIONAL-SPEC.md` for the full picture.
