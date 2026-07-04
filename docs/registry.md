# Habeas community source registry

How community **sources** (declarative adapters, DATA not code) are shared, discovered, rated, and
installed. Hybrid model: **GitHub repo = source of truth** (auditable, PR-reviewed, no server to
install); **thin habeas.dev service = social layer only** (ratings + comments). Everything the
extension needs to *install* works with zero backend.

## 1. The repo — `github.com/habeas-dev/sources`

```
sources/
  <id>.json            # one source per file, e.g. sources/carrefour-es.json
index.json             # generated catalog (CI), served at https://habeas-dev.github.io/sources/index.json
schema/adapter.schema.json   # copy of the extension's adapter schema (CI validates against it)
```

- **Contributing** = open a PR that adds/edits `sources/<id>.json`. The extension's **Share**
  button builds the JSON and opens a prefilled GitHub "new file" PR (`registry/share.js`).
- **CI gate** (required to merge): each `sources/*.json` must
  1. validate against `schema/adapter.schema.json`, and
  2. pass the same-domain guard (`checkHosts`) — every host shares one eTLD+1, or extra hosts are
     declared in `crossDomainHosts` (which flags the source as "sends session off-site").
  Financial sources are welcome (see CONTRIBUTING); the guard, not the category, is the boundary.
- **`index.json` build** (CI, on merge to `main`): map each source file to a catalog entry.

### `index.json` entry shape

```json
{
  "id": "carrefour-es",
  "name": "Carrefour España — tickets",
  "service": "carrefour",
  "categories": ["grocery", "fuel", "retail"],
  "trust": "community",
  "domain": "carrefour.es",
  "crossDomain": [],
  "version": "2026-07-04",
  "url": "https://habeas-dev.github.io/sources/carrefour-es.json",
  "updated": "2026-07-04T00:00:00Z"
}
```

`url` points at the raw source JSON. `crossDomain` non-empty ⇒ the marketplace shows a
"⚠ sends session off-site" badge and install still requires the in-extension consent screen.

The extension consumes this via `registry/client.js#fetchIndex` and installs with
`installFromEntry` (download → `validateAdapter` → `saveSource`). Install never trusts the index
blindly — it re-validates the downloaded JSON locally.

## 2. The social service — `https://api.habeas.dev` (optional)

The **only** mutable/social data. If absent, the marketplace still browses and installs; ratings
and comments simply don't render. Client: `registry/client.js` (all calls fail soft).

| Method & path | Body | Returns |
|---|---|---|
| `GET  /sources/{id}/ratings` | — | `{ "avg": 4.3, "count": 128 }` |
| `POST /sources/{id}/ratings` | `{ "stars": 1..5 }` | updated `{ avg, count }` |
| `GET  /sources/{id}/comments` | — | `[ { "author": "...", "text": "...", "at": "ISO" } ] ` |
| `POST /sources/{id}/comments` | `{ "text": "..." }` | created comment |

- `id` is the source id; ratings/comments are keyed by id (optionally id+version).
- Writes carry an optional `Authorization: Bearer <token>` (anti-abuse / identity — e.g. GitHub
  OAuth). The service owns rate-limiting, spam control, and moderation.
- The service stores **no personal user data and no extracted documents** — only opinions about a
  public source id. Keeps the project's local-first posture intact.

## 3. Trust & safety recap

- Sources are **data, not code** — validated on the way in (repo CI *and* at install time).
- **Same registrable domain** is the enforced boundary: a source can only replay the captured
  session to the *same* service it was captured from. Cross-domain needs an explicit allowlist and
  a prominent consent screen. See `adapters/validate.js`, `lib/consent.js`, spec SEC-5.
- Trust is a **label** (`first-party` audited vs `community`), surfaced in the marketplace and the
  Settings source list — not a category block.
