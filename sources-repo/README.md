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
**https://sources.habeas.dev** (`index.json`, `<id>.json`, `adapter.schema.json`). The extension
reads `https://sources.habeas.dev/index.json` (`extension/src/registry/client.js`). Ratings and
comments are served by a separate small service at `https://habeas.dev/api` (optional; the
extension degrades gracefully without it). See the extension repo's `docs/registry.md`.

## Local checks

```
npm install
npm run validate        # validate every source
npm run build-index     # regenerate sources/index.json
```
