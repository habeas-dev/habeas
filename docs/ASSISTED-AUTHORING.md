# Assisted source creation — how the pipeline works (team guide)

> For the Habeas **team**. This documents the *assisted* path from
> [ADDING-SOURCES.md](ADDING-SOURCES.md): a contributor records a session in the extension, a redacted
> capture reaches us, and we finish, verify, and publish the source — collaborating with the
> contributor through a private thread. It also covers the tooling that makes this safe (redaction,
> instrumentation) and how a maintainer operates the review/publish workflow.

The goal: a **non-technical person** can contribute a working source without writing code, sharing raw
data, or understanding the adapter model — and we can author it **without ever seeing their real
values**.

---

## The pipeline

```
Contributor (in the extension)                 Team (api.habeas.dev + repo)
────────────────────────────                   ────────────────────────────
1. Record mode  (learn.js)          ─┐
2. Auto-draft   (infer.js)           │  redact  (redact.js)   → a bundle where every VALUE is a
3. Visual map + live Test (author.*) │                          type placeholder, structure intact
4. Send to the team  (client.js) ────┼──► 5. Submission thread (handler.mjs / D1)
                                      │        review · ask questions · request a targeted recording
   ◄── two-way thread, "install this ─┘        attach a fixed source version (one-click install)
       version" cards, capture reqs           6. Verify offline (replay harness)
                                              7. Publish to habeas-dev/sources · credit the contributor
```

---

## 1–4. The contributor side (in the extension)

- **Record mode** — `extension/src/lib/learn.js`. `startLearning(url)` requests host permissions for
  the registrable domain, injects the capture bridge (`hook.js` MAIN world + `bridge.js` ISOLATED),
  flags `habeas:learn`, and opens the tab. As the user browses signed-in, samples, WebSocket frames,
  `localStorage`, document (asset) URLs, and the captured auth land in `storage.session`
  (`getSamples/getWsFrames/getStorage/getAssets/getAuthFor`). `stopLearning` tears it down.
- **Auto-draft** — `extension/src/runtime/infer.js` (pure, deterministic). `draftAdapterFromSamples`
  turns the samples into a first source: it deduces the list endpoint(s), paging, item path, fields,
  detail/PDF fetch, CSRF, auth context, HTML rows, and grouped/streamed shape
  (`draftStreamsFromSamples`, `draftWithGroups`), and flags cross-domain hosts (`applyCrossDomain`).
- **Visual mapper + live Test** — `extension/src/ui/author.{html,js}`. The contributor reviews the
  inferred draft, maps fields per schema (`SCHEMA_FIELDS`), and hits **Test**, which runs the real
  `listInventory` against the live session so they see actual rows before sharing. From here they can
  **save locally** (the *local-only* path) or **send to the team**.

## 5. The submission thread (backend)

`api-repo/` is a Cloudflare Worker + D1 (`handler.mjs`, `store-d1.mjs`; `store-memory.mjs` for tests).
Everything is a **pure** `handleRequest(request, env)`. The handoff endpoints:

| endpoint | who | what |
|---|---|---|
| `POST /handoff` | contributor | submit a redacted bundle (`bundle.habeasHandoff===1`, ≤2 MB) → `{id, status:'new'}`; a new submission for the same source supersedes the prior one. |
| `GET /handoff` | team (admin token) | list submissions. |
| `GET /handoff/:id` | team / contributor | full thread (admin) or submitter-scoped status+thread+source. |
| `POST /handoff/:id/messages` | both | two-way Q&A (team via admin token, contributor via their pseudonymous id). |
| `POST /handoff/:id/recording` | contributor | attach a **targeted re-recording** into the same thread (see capture requests). |
| `POST /handoff/:id` | team | set status · link `sourceId` · attach `sourceJson` (a **versioned "install this" card**) · post a **captureRequest** `{instruction, endpoint, reveal}`. |
| `GET /submitter/:sid/handoffs` | contributor | their pseudonymous inbox. |

**Statuses:** `new → in_review → needs_info` → terminal `published` / `completed` / `declined` /
`superseded`. `waitingForTeam` is derived when a thread is non-terminal and the last word is the
contributor's. Team notifications fire to Telegram (`notifyTeam`, best-effort). Limits: 2 MB/bundle,
12 000 chars/message, 20 handoffs/hour.

**Capture requests** let us ask a non-technical contributor to record **one specific screen** ("open
your inactive deposits and let it load") — the extension turns it into a guided recording that lands
back in the same thread. Use these instead of asking them to open DevTools.

## Redaction & instrumentation — authoring without the real data

- **`extension/src/lib/redact.js`** builds the shareable bundle: `buildHandoff({domain, samples,
  wsframes, assets, storage})`. It keeps **structure** (paths, param names, field names, response
  shapes) and replaces every **value** with a typed placeholder — `[date] [amount:EUR] [id#N] [jwt#N]
  [iban] [card] [email] [text]`. Correlation is preserved: the *same* real id becomes the *same*
  `[id#N]` everywhere (so you can see that the `Authorization` bearer equals
  `localStorage.auth_token.access_token` without ever seeing it). `findOrphans`/`revealOrphans` let the
  owner selectively un-redact an id that only appears in requests (a needed path segment).
  `collectJwtClaims`/`collectStorageTokens` surface where tokens live (path + kind), never their value.
  Bundle shape: `{habeasHandoff:1, kind:'redacted-recording', domain, note, counts, samples[],
  wsframes[], assets[], storage, tokenClaims[], tokenLocations[]}`.
- **`extension/src/lib/diag.js`** is the live diagnostic surface. `pushDiag/formatDiag` accumulate the
  exact failed requests (phase/output/kind/item/method/url/status/message) behind **Report a problem**.
  The **request-context ring** (`pushReqCtx/formatReqCtx`, `redactReqVal`) records, per observed
  request, a redacted diff of the SPA's request vs our replay — header *names* + value *fingerprints*
  (not values), redacted query, header order, and the sent token's `iat`/`exp` — so we can find why a
  replay is rejected (a wrong `Accept`, a literal `{ctx.*}`, a rotated token) **from the report alone**.
  This is what let us fix hard cross-domain banks without ever seeing a real value.

## 6. Verify before publishing

Run the offline harness against the submitted bundle (fetchable with `--handoff <id>`):

```bash
node scripts/replay-capture.mjs --handoff <id> --source path/to/source.json
```

Every output must `PASS` (see [AUTHORING-SOURCES.md §4](AUTHORING-SOURCES.md#4-verify-offline-with-the-replay-harness)).
`keep.prefix` filters legitimately show `listed=0` offline when ids are redacted — verify the parse by
temporarily relaxing `keep`, and cover the prefix split with a unit test.

## 7. Publish & credit

- Attach the finished source as a version card (`POST /handoff/:id` with `sourceJson`) so the
  contributor can one-click install and re-test.
- Publish to **`habeas-dev/sources`** by applying the change in a clone and pushing **non-force
  (fast-forward)** — never subtree-split/force-push that repo. Bump the source `version`; set
  `minVersion` if it needs a newer runtime. Full steps: [RELEASING.md](RELEASING.md).
- Set the handoff `status` to `published` (or `completed`) and **credit the contributor** in the
  source/PR. Only real, API-verified sources ship.

---

## Where each piece lives

| concern | file(s) |
|---|---|
| record mode | `extension/src/lib/learn.js`, `content/hook.js`, `content/bridge.js`, `lib/capture.js` |
| auto-draft | `extension/src/runtime/infer.js` |
| visual mapper | `extension/src/ui/author.{html,js}` |
| share / marketplace | `extension/src/registry/share.js`, `registry/client.js` |
| redaction | `extension/src/lib/redact.js` |
| instrumentation | `extension/src/lib/diag.js` |
| handoff backend | `api-repo/src/handler.mjs`, `store-d1.mjs`, `store-memory.mjs`, `schema.sql` |
| offline verify | `scripts/replay-capture.mjs` |
| publish | `docs/RELEASING.md`, `docs/registry.md` |

The *local-only* and *advanced* paths are in [ADDING-SOURCES.md](ADDING-SOURCES.md) and
[AUTHORING-SOURCES.md](AUTHORING-SOURCES.md).
