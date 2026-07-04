# habeas-dev/api

Ratings & comments for [Habeas](https://github.com/habeas-dev/habeas) community sources — a thin
**Cloudflare Worker + D1** service. It is the *only* social/mutable piece of the registry; the
source catalog itself is static ([habeas-dev/sources](https://github.com/habeas-dev/sources)). The
extension degrades gracefully when this service is offline (it just hides ratings/comments).

Stores **no personal data and no extracted documents** — only opinions keyed by a public source id,
plus a daily-salted hash of the caller IP (never the raw IP) for rate limiting.

## API (served at `https://api.habeas.dev`)

| Method & path | Body | Returns |
|---|---|---|
| `GET  /sources/{id}/ratings`  | — | `{ avg, count }` |
| `POST /sources/{id}/ratings`  | `{ stars: 1..5 }` | `{ avg, count }` (one rating per client; re-vote updates) |
| `GET  /sources/{id}/comments` | — | `[ { author, text, at } ]` (visible only, newest first) |
| `POST /sources/{id}/comments` | `{ text, author? }` | the created comment |

Anonymous, with a per-client rate limit (30 writes/hour) and a `status` moderation flag on
comments (`visible` / `hidden` / `pending`). CORS is open (`*`) so the extension can call it.

## Layout

```
worker.mjs            Cloudflare entry (D1 store + IP-hash fingerprint)
src/handler.mjs       pure request handler (routing, validation, rate limit) — unit-tested
src/store-d1.mjs      D1 (SQLite) store
src/store-memory.mjs  in-memory store (tests / local)
schema.sql            D1 tables
test/handler.test.mjs node:test suite (in-memory store)
wrangler.toml         Worker + D1 binding + api.habeas.dev route
```

## Develop & test

```
npm test              # node --test, no cloud needed
npm run dev           # wrangler dev (local Worker + local D1)
```

## Deploy (one-time setup)

```
npm i
npx wrangler login
npx wrangler d1 create habeas-api          # paste the printed database_id into wrangler.toml
npm run db:init:remote                       # create tables in production D1
npm run deploy                               # publish the Worker
```

Then point **api.habeas.dev** at the Worker: either keep the `[[routes]]` block (needs habeas.dev
as a Cloudflare zone) or add a **Custom Domain** `api.habeas.dev` to the Worker in the dashboard.
The extension reads `https://api.habeas.dev` (`extension/src/registry/client.js`).

### CI auto-deploy (optional)

CI runs the tests on every push/PR. To auto-deploy on merge to `main`, add repo secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (Settings → Secrets). Without them the deploy
step is skipped, not failed.
