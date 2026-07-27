# AGENTS.md — working on Habeas with an AI coding assistant

> This is the **vendor-neutral** onboarding for AI coding agents (Codex, Cursor, Aider, Gemini CLI,
> Continue, …). **Claude Code** users also get [`CLAUDE.md`](CLAUDE.md) automatically — it has the
> fullest project context; read it too if your tool doesn't load it for you. Humans: start at
> [`README.md`](README.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).

Everything here is what an agent needs to be productive **safely** in this repo on the first try.

---

## What Habeas is (30 seconds)

Habeas is an open-source (AGPL-3.0) **Manifest V3 browser extension** (Chrome **and** Firefox) that lets a
user extract **their own** personal data — receipts, invoices, bank/card/investment records — from services
that offer no API and no bulk export.

**Core thesis (never break this):** it runs **inside the user's own already-authenticated browser session**,
so it *inherits* the user's valid session (never fights anti-bot), **never stores credentials**, and lets the
user resolve MFA/OTP live. It is the opposite of a server-side scraper. Every change must preserve this.

The authoritative runtime lives in **`extension/src/`**. Data sources are **declarative data, not code**.

---

## Quick start

```bash
npm install
npm test          # node:test unit suite — extension/test/*.test.mjs
npm run lint      # web-ext lint (0 errors required; some innerHTML/Firefox-API warnings are expected)
npm run package   # lint + build the MV3 zip → dist/ (loads in BOTH Chrome and Firefox)
```

Load the extension unpacked while developing:
- **Chrome:** `chrome://extensions` → Developer mode → *Load unpacked* → select `extension/`.
- **Firefox:** `about:debugging` → *Load Temporary Add-on* → `extension/manifest.json`.

The version in `extension/manifest.json` shows in the popup and `chrome://extensions`, so **bump it on every
change** (see Conventions) to make a reload verifiable.

---

## Where things are

```
extension/                 # THE EXTENSION — the code that ships
  manifest.json            # MV3; version lives here
  _locales/{en,es}/        # i18n (en = default); keys MUST stay in parity across both
  src/
    background.js          # service worker: capture, auto-sync, send/deliver
    lib/                   # ext shim, config, secrets/crypto, store, sinks helpers, i18n, …
    adapters/              # loader + validate.js (schema + same-domain guard) + carrefour-es.js
    content/               # page hooks that capture the SPA's auth headers (never bodies/cookies)
    runtime/               # inventory.js (declarative pager/mapper) + lister.js + infer.js
    sinks/                 # sinks.js, format.js (record shapes), drive/dropbox/…
    ui/                    # popup, options (Settings), archive, author (record mode), marketplace
  test/                    # node:test unit tests (*.test.mjs) + e2e/
docs/                      # deep docs (see the map below)
sources-repo/              # STAGING copy of the community source catalog (separate live repo)
CLAUDE.md                  # full project context (rich); AGENTS.md is its neutral summary
```

Root `core/`, `schemas/`, `adapters/*.yaml` are **early design scaffolding**, not the runtime. The runtime
is `extension/src/`.

---

## The non-negotiable rules

1. **Adapters (sources) are DATA, not code.** A source is a plain JSON/JS object interpreted by the fixed
   runtime (`runtime/inventory.js`). No `eval`, no remote code (also an MV3 rule). If the declarative format
   can't express something, **extend the runtime + its schema** for everyone (with a test) — never smuggle
   logic into a source.
2. **Local-first.** Data never leaves the browser unless the user picks a destination (sink).
3. **No credential storage, ever.** Rely on the live session. The scraped session token lives only in
   `storage.session` (memory, cleared on browser close) — never on disk.
4. **Same registrable domain (eTLD+1) is the hard trust boundary.** Every host a source touches (its
   `match` site, its `api.host`) must share ONE eTLD+1. Cross-domain needs an explicit `crossDomainHosts`
   allowlist, which forces a prominent off-site consent screen. Enforced in `adapters/validate.js`.
5. **Triggers are user-initiated / on-login.** No background scraping with a stored session while the user
   is away.
6. **Only touch a source when the data isn't already local.** When delivering already-saved documents, read
   files back from a retrievable store (Dropbox/WebDAV/S3) before re-opening the source site.

---

## Conventions (how to make a change)

- **Language:** code, comments, docs, commit messages in **English**.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) (`feat(scope): …`,
  `fix(scope): …`). **Do NOT add AI-attribution trailers** (`Co-Authored-By`, `Claude-Session`, etc.) — the
  history is kept clean of them.
- **Version:** bump `extension/manifest.json` in the **same commit** as the change. A 3-part milestone
  (`0.9.2`) + optional 4th dev suffix (`0.9.2.1`, bumped on every change; only milestones are tagged `vX.Y.Z`
  and shipped). Update `CHANGELOG.md` under `## [Unreleased]` in the same commit.
- **Before every commit** (CI enforces these):
  - `npm test` green;
  - `node --check` each touched `.js` (syntax);
  - **en/es locale key parity** — both `_locales/*/messages.json` must have the exact same key set;
  - `npm run lint` → **0 errors**.
- **Cross-browser:** any module using extension APIs imports the shim from `lib/ext.js`
  (`const chrome = globalThis.browser ?? globalThis.chrome`) so promise-based calls work in Firefox too.
- **Never commit real captures or secrets.** A pre-commit hook (`scripts/scan-pii.mjs`, run via
  `npm run scan:pii`) blocks PII/secrets. Author sources from a real capture kept **outside** the repo, and
  synthesize any test/example data from scratch (never reuse a real value — a date, amount, id, name).
- **Prefer TDD:** add a failing `node:test` first, then implement, when practical.

---

## The main contribution: adding a source

Most contributions are a **new source** (aka adapter). Three paths — full overview in
**[`docs/ADDING-SOURCES.md`](docs/ADDING-SOURCES.md)**:

- **Record mode (easiest):** open the extension → *Record & contribute* → *Create a source*, browse your
  data so Habeas observes the real API calls, then Analyze → map fields → Test → Save → Share (opens a
  prefilled PR to the [`habeas-dev/sources`](https://github.com/habeas-dev/sources) catalog).
- **Assisted:** record it and send it to the Habeas team, who finish + publish it —
  **[`docs/ASSISTED-AUTHORING.md`](docs/ASSISTED-AUTHORING.md)**.
- **Advanced (proxy + AI):** capture traffic (e.g. mitmproxy) and hand-author with an AI — the **complete
  adapter/runtime reference** is in **[`docs/AUTHORING-SOURCES.md`](docs/AUTHORING-SOURCES.md)**.

Only **real, API-verified** sources are published — never invented endpoints or fields. Validate with
`adapters/validate.js` and run the runtime against the captured response before proposing a source.

The community catalog is a **separate repo** served at `habeas-dev.github.io/sources`; `sources-repo/` here
is a staging copy. Releasing/publishing steps: **[`docs/RELEASING.md`](docs/RELEASING.md)**.

---

## Doc map (where to go deeper)

| Topic | File |
|---|---|
| Full project context (Claude-oriented, richest) | [`CLAUDE.md`](CLAUDE.md) |
| Architecture & principles | [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`PHILOSOPHY.md`](PHILOSOPHY.md) |
| Functional spec (design rationale) | [`docs/FUNCTIONAL-SPEC.md`](docs/FUNCTIONAL-SPEC.md) |
| Adding a source (3 ways) | [`docs/ADDING-SOURCES.md`](docs/ADDING-SOURCES.md) |
| Complete adapter reference | [`docs/AUTHORING-SOURCES.md`](docs/AUTHORING-SOURCES.md) |
| Canonical store model | [`docs/canonical-store.md`](docs/canonical-store.md) · [`STORE.md`](STORE.md) |
| Categories & schemas | [`docs/categories.md`](docs/categories.md) |
| Incremental sync | [`docs/incremental-sync.md`](docs/incremental-sync.md) |
| Consumer/integration (HTTP ingest) | [`docs/INTEGRATION.md`](docs/INTEGRATION.md) |
| Registry/social API contract | [`docs/registry.md`](docs/registry.md) |
| Release + catalog publish | [`docs/RELEASING.md`](docs/RELEASING.md) |
| Store OAuth setup | [`docs/drive-oauth.md`](docs/drive-oauth.md) · [`docs/dropbox-oauth.md`](docs/dropbox-oauth.md) |

---

## Legal posture (so you don't over-promise)

Grounded in GDPR Art. 20 / *habeas data*: the user's own data, in the user's session, via user-run OSS.
Habeas is **not** a PSD2-regulated actor (no payment initiation). Each service's ToS may restrict automated
access — documented, and the user's responsibility. Keep this framing; don't add capabilities that scrape on
the user's behalf server-side or store their credentials.

## Don't

- Don't put imperative logic in a source, or fetch remote code.
- Don't add AI-attribution commit trailers.
- Don't commit real user data / captures / secrets, or reuse real values as test data.
- Don't broaden host permissions or cross the same-domain boundary without `crossDomainHosts` + consent.
- Don't publish an unverified/invented source to the live catalog.
