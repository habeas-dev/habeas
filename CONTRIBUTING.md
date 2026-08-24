# Contributing to Habeas

Thanks for helping people reclaim their own data. The most valuable contribution
is usually a **new adapter**.

> **Working with an AI coding assistant** (Codex, Cursor, Aider, Gemini, Claude Code…)? Read
> **[AGENTS.md](AGENTS.md)** first — it's the concise, safe onboarding for agents (build/test commands,
> the non-negotiable rules, repo layout, and where to go deeper).

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

## Licensing of contributions

### Code

By submitting code to this repository you agree that:

- it is licensed under **AGPL-3.0**, the same licence as the project; and
- you grant the maintainer a perpetual, worldwide, irrevocable, non-exclusive
  right to use it and to license it under any terms, in derivative works and in
  other products — typically a service built on top of this code.

**One exception, and it is the point of the whole clause: any browser extension
that runs inside the user's own session stays AGPL-3.0, permanently.** The line
is drawn by where the code runs rather than by what it is called, so a rebranded
or white-labelled build is covered just the same. It rules out closing such
code. It does not rule out charging for it, or putting someone else's name on
it — "free" here means free to inspect.

Why that exception is not just a promise is set out in full on the website,
under [why you should not have to trust
Habeas](https://habeas.dev/why-habeas.html#audit). The short version: AGPL-3.0
§2 grants its rights for the term of the copyright and makes them irrevocable,
so every release published so far stays free whatever becomes of this project,
and that does not depend on anyone's goodwill.

### Sources

Source definitions are declarative data rather than code, and live in a separate
catalogue, [`habeas-dev/sources`](https://github.com/habeas-dev/sources). They
carry their own terms, chosen so that nobody has to think twice before using
them:

- **The definition** — every machine-readable field — is placed in the public
  domain under [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/). It
  describes how a service has arranged the user's own data, which is mostly fact
  rather than authorship, and it is worth more to everyone with no strings on it.
- **The `content` field** — the prose that becomes a guide page on habeas.dev —
  is [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/): reuse it freely,
  with credit.

By submitting a source you also confirm that:

- you wrote it, or derived it by observing a service you were entitled to use;
- **it contains no personal data** — no real names, addresses, account or card
  numbers, amounts, document ids, or captured sample responses; and
- **it contains no credentials** — no tokens, cookies, keys or session material
  in any field, examples included.

Those last two matter more here than in most projects, because sources are
authored from captures of a real account. Keep the capture outside the
repository, and let nothing from it reach the definition: invent example values
instead of trimming real ones.

## Principles this project will not compromise on

- Local-first: nothing leaves the browser without explicit user consent.
- No credential storage.
- The Core stays small and auditable; complexity lives in declarative adapters.

See `CLAUDE.md` and `docs/FUNCTIONAL-SPEC.md` for the full picture.
