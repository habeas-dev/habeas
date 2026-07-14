# Notes for add-on reviewers (AMO / Chrome Web Store)

## What it does (single purpose)
Habeas lets a user export **their own** data (receipts, invoices, orders, card/investment statements)
from services they are **already logged into**, and save it where they choose (a download, a local
folder, their own Google Drive, Dropbox, an S3 / S3-compatible bucket, a WebDAV server, or an HTTP
endpoint they configure). It runs entirely inside the user's
existing authenticated session. It stores **no credentials** and runs **no Habeas server that receives
user data**.

## No remote code (important)
The extension executes **no remote JavaScript** and uses no bundler/minifier — the source in the package
**is** the source (`npm install && npm run build` reproduces the zip from `extension/`).

"Sources" are **declarative DATA**, not code: JSON objects describing a site's list/detail/PDF endpoints
and field mappings. They are interpreted by a fixed runtime (`extension/src/runtime/inventory.js`) — there
is **no `eval`, no `new Function`, no remote script**. A built-in example (Carrefour) ships in the package;
additional sources are optional JSON the user installs from a public catalog. Every source is validated
before use (`extension/src/adapters/validate.js`): it must be well-formed JSON matching the schema and must
satisfy a **same-registrable-domain guard** (a captured session may only be replayed to the same site it
was captured from; any cross-domain use requires an explicit allowlist **and** a prominent consent screen).

## Network calls to project infrastructure
- **Catalog** (`https://habeas-dev.github.io/sources/index.json` + source JSON files): static JSON **data**
  the user browses/installs from — no code, no user data sent.
- **Ratings/comments** (`https://api.habeas.dev`): optional; only when the user rates/comments a source.
  Sends a source id + a star rating / comment text. **No personal or extracted data.**
- **Google APIs** (`googleapis.com`): only if the user connects the optional Google Drive sink (OAuth
  `drive.file`, files this app creates).
- **User-configured delivery targets** (optional Dropbox, S3 / S3-compatible, WebDAV or HTTP sinks): the
  user's extracted data is uploaded **only** to the host the user themselves entered/authorized for that
  sink. Dropbox uses a public OAuth app (`drive.file`-style, files this app creates); S3/WebDAV/HTTP use
  credentials the user supplies. No Habeas server sits in between.
Everything else (the user's actual data) goes only to the destination the user configured, or stays local.

## Permissions (rationale)
Full text in `docs/store-permissions.md`. Summary:
- **cookies** — only to clear a site's **own** corrupted login cookies (some sites break their own login);
  never reads/transmits cookie values.
- **webRequest** — **observation-only** (non-blocking); reads the `Authorization` header + URL of requests
  the site makes to **its own** API, so the extension can replay them to the same API. Token kept in
  `storage.session` (memory, cleared on browser close). No response bodies, no other sites.
- **scripting** + **`optional_host_permissions: https://*/*`** — requested **per site, on demand**: the
  extension touches a website only after the user explicitly **enables a source** for it (and accepts a
  consent screen for cross-domain sources). The broad *optional* pattern exists so users can add community
  sources for any service they personally use, without a shipped allowlist. It is not granted up front.
- **declarativeNetRequestWithHostAccess** — set the `Referer` header on a source's own API/PDF requests
  (a `fetch` cannot). **identity** — Google Drive OAuth only. **downloads/notifications/storage** — save
  exports / notify on auto-sync / store local config (tokens memory-only).

## Content scripts
- `content/extbridge.js` (matches `https://*/*`, `document_idle`): a **passive `window.postMessage`
  bridge** for the optional "site integrations" feature — a site may *propose* sending the user's own data
  back to **its own origin** (origin-bound + explicit consent, mints a revocable grant). It does not read
  page content on its own.
- The **capture** hook runs only on a site the user has **enabled a source** for (registered dynamically),
  to read the user's auth as they browse that site.

## How to test
The extension is **inert until the user enables a source and logs into that service themselves** — so
end-to-end testing needs an account on a supported service.
- The **runtime logic** can be exercised without any account: `npm install && npm test` runs a Node test
  suite that drives the parser/pager/sinks against fixtures (`extension/test/`).
- For a manual smoke test without logging into a real service: load the extension, open the popup — with no
  source enabled it simply reports "no data sources". Enabling a source shows the consent screen; nothing
  runs against any site until the user does so and is logged in there.
- The bundled Carrefour source targets `carrefour.es` (Spain), which requires a Carrefour account + email
  OTP; happy to provide a screencast of a full run if useful.

## Privacy summary
No data is collected or transmitted off-device by the extension itself; extracted data goes only to the
sink the user configures (their own Drive/folder/endpoint). Nothing is sold or shared. Session tokens live
in memory (`storage.session`) and are cleared when the browser closes; no credentials are ever stored.
