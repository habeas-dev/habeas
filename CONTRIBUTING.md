# Contributing to Habeas

Thanks for helping people reclaim their own data. The most valuable contribution
is usually a **new adapter**.

## Contributing an adapter

Adapters are **declarative data, not code** (see `adapters/README.md`). To add one:

1. Copy an existing adapter (e.g. `adapters/carrefour-es.yaml`) as a starting point.
2. Fill in the service's host match, login signal, list/detail fetch, field
   mapping, dedupe key, target schema, and capability scope.
3. Validate it against `adapters/schema/adapter.schema.json`.
4. Map your fields into an existing normalized schema in `schemas/` (open an issue
   first if you need a new one).
5. Open a PR describing: the service, what data it exposes, and any legal/ToS
   caveats you're aware of.

### Rules for adapters

- **No code.** If your service needs logic that the declarative format + the
  predefined transforms can't express, open an issue — we extend the format for
  everyone rather than allowing arbitrary JS.
- **Least privilege.** Declare the narrowest `capabilities` (hosts read, sink
  written) that works.
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
