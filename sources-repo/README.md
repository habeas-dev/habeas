# habeas-dev/sources

Community **source** registry for the [Habeas](https://github.com/habeas-dev/habeas) browser
extension. A *source* describes how to extract a user's **own** data from one service, in the
user's own session. Sources are **DATA, not code** — plain JSON, no logic, no remote scripts.

- **Browse & install** from inside the extension (Settings → *Browse community*).
- **Contribute** by opening a PR that adds `sources/<id>.json` (the extension's *Share* button
  builds this PR for you).

## Layout

```
sources/<id>.json          one source per file (e.g. sources/carrefour-es.json)
sources/index.json         generated catalog (CI, do not edit by hand)
schema/adapter.schema.json  the source JSON Schema (kept in sync with the extension)
scripts/                   validate.js (guard, synced from the extension) + CI scripts
```

## What CI enforces on every PR (`npm run validate`)

1. **Valid adapter data** — no functions/code; required fields present.
2. **Same registrable domain (eTLD+1)** — every host a source touches (its `match` site, its
   `api.host`) shares one registrable domain, so a captured session can only be replayed to the
   *same* service. Cross-domain services must list the extra hosts in `crossDomainHosts`, which
   flags the source as "sends session off-site" (the extension then shows an explicit consent
   screen before it runs).
3. **JSON Schema** conformance (`schema/adapter.schema.json`).

Financial sources (banking, cards, investments) are welcome under this guard — a source only
describes public data structure; the domain boundary, not the category, is the safety line. See
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Publishing

On merge to `main`, CI builds `sources/index.json` and deploys the catalog + source files to
**https://habeas-dev.github.io/sources** (`index.json`, `<id>.json`, `adapter.schema.json`). The extension
reads `https://habeas-dev.github.io/sources/index.json` (`extension/src/registry/client.js`). Ratings and
comments are served by a separate small service at `https://habeas.dev/api` (optional; the
extension degrades gracefully without it). See the extension repo's `docs/registry.md`.

## Local checks

```
npm install
npm run validate        # validate every source
npm run build-index     # regenerate sources/index.json
```

## Licence

Two different kinds of thing live in these files and they carry different terms. Full text of both
in [`sources/LICENSE`](./sources/LICENSE).

- **The definition** — every machine-readable field — is in the public domain under
  **[CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/)**. A definition records how a
  service happens to have arranged data that already belongs to its user: mostly fact rather than
  authorship, and worth more to everybody with nothing attached to it. Use it anywhere, including
  commercially, with or without credit.
- **The `content` field** — the prose that becomes a guide page on habeas.dev — is
  **[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)**: reuse it freely, with credit.

`scripts/` and `schema/` are code and stay **AGPL-3.0** ([LICENSE](./LICENSE)).
