# Habeas extension (Manifest V3)

Cross-browser (Chrome/Chromium **and** Firefox) MV3 extension that extracts your own data
within your logged-in session and sends it to a destination you choose.

## Layout

```
extension/
├── manifest.json              # MV3; dual background (service_worker + scripts) for Chrome/Firefox
├── icon*.png / icon*.svg      # logo (light + dark variants)
├── _locales/{en,es}/          # i18n messages (en = default)
├── fonts/                     # self-hosted Space Grotesk + Inter (no third-party requests)
└── src/
    ├── background.js          # captured auth (storage.session, never on disk) + auto-sync runner + sample buffer
    ├── lib/
    │   ├── ext.js             # cross-browser API shim (browser ?? chrome)
    │   ├── config.js          # datasources / sinks / routes  (storage.local, versioned JSON)
    │   ├── secrets.js         # sink credentials, SEPARATE store, AES-GCM at rest, referenced by secret://
    │   ├── crypto.js/keystore.js # AES-GCM envelope + non-extractable IndexedDB CryptoKey
    │   ├── state.js           # delivery ledger (dedupe) + activity log
    │   ├── store/ + store.js  # canonical document store (local/folder/http/drive/dropbox/webdav/s3 backends)
    │   ├── normalize.js       # declarative counterparty extraction + uniform canonicalize output
    │   ├── outputs.js         # streams × formats → selectable (stream, format) outputs
    │   ├── fs.js              # File System Access directory handles (IndexedDB)
    │   ├── zip.js             # minimal store-only ZIP writer
    │   ├── naming.js          # path templates {service}/{yyyy}/{date}-{internalId}.{ext}
    │   ├── badge.js           # toolbar badge states (working/count/error)
    │   ├── theme-icon.js      # light/dark toolbar icon
    │   ├── learn.js           # record mode (in-session response samples)
    │   └── i18n.js            # applyI18n() + t()
    ├── adapters/              # carrefour-es.js (data, not code) + index.js catalog + loader/validate
    ├── content/               # bridge.js (isolated) + hook.js (page): capture JWT + CSRF; learn-mode samples
    ├── runtime/               # inventory.js (declarative pager) + infer.js (record-mode auto-draft)
    ├── registry/              # share.js (export/import + PR) + client.js (catalog + ratings API)
    ├── sinks/                 # sinks.js · format.js · drive.js · dropbox.js (delivery sinks)
    └── ui/                    # popup (app tab) + options + author/marketplace/store-browser/docview + theme.css
```

## Features

- **Data sources:** Carrefour España (first-party, audited) plus community sources installed from
  the marketplace (11+ live, incl. ING España). A source captures your session (JWT + CSRF) and
  enumerates all documents, downloading each PDF/artifact. Documents the service no longer retains
  are exported as metadata (in the manifest) only.
- **Declarative runtime:** `runtime/inventory.js` enumerates documents with a declarative pager —
  `offsets | offset | page | cursor | none | years | synthetic` (synthetic = per-period/per-account
  documents such as monthly statements). Sources may declare `streams[]` × `formats[]` → selectable
  `(stream, format)` **outputs** (e.g. WiZink: movimientos + statement PDF + statement Excel).
- **Destinations (sinks):** `download` (one ZIP + manifest), `local-folder` (File System Access —
  Chromium; point it at a synced folder for cloud), **`drive`** (native Google Drive, OAuth
  `drive.file`), `http` (POST to your own endpoint), **`webdav`**, **`s3`** (AWS + S3-compatible,
  SigV4), **`dropbox`**. A declarative normalize layer can emit a uniform canonical record per sink.
- **Canonical document store:** everything recovered is kept in a canonical store with pluggable
  backends (local IndexedDB, folder, http, drive, dropbox, webdav, s3); a Settings inspector lets
  you pick the backend and delete entries.
- **Popup surfaces:** a **Documents** tab (cross-source browser of everything recovered), the
  per-source list with *new* / *already-sent* marks and per-sink **dedupe** (select New/All/None),
  and a persistent per-account filter for grouped (bank) sources.
- **Automatic mode:** when you log in, new documents sync to a runnable destination
  (desktop notification + activity log).
- **Config** in `storage.local`, secrets in a separate AES-GCM-encrypted store, session token only
  in `storage.session` (memory, never disk); UI in English/Spanish.
- **Community sources & trust:** same-registrable-domain guard + consent for cross-domain; financial
  community sources are allowed under the guard, with `first-party` shown as an audited *label*, not
  a gate. Record mode (`lib/learn.js` → `runtime/infer.js` → `ui/author.*`) drafts new sources from a
  live session; sharing exports JSON / opens a prefilled PR to `habeas-dev/sources`.

## Load it (developer / unpacked)

**Chrome / Chromium:** `chrome://extensions` → enable Developer mode → **Load unpacked** →
pick this `extension/` folder.

**Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick
`manifest.json` (or the packaged `dist/habeas-<version>.zip`, built with `web-ext build`).

Then: open the toolbar icon → **Settings**, enable the **Carrefour** data source and add a
destination. Open `carrefour.es` → *Mis compras* (to capture your session), then in the
Habeas tab → **List documents** → select → **Send to**.

## Browser notes

- **Local folder** sink needs the File System Access API → Chromium only; on Firefox use
  Downloads or Drive (the option guards itself).
- **Google Drive** OAuth uses `launchWebAuthFlow`; the redirect URL differs per browser, so
  the shipped client currently targets Chromium. For Firefox, register its redirect URL
  (shown in Settings) on your own OAuth client.

## Status

Public **beta**, published on the **Chrome Web Store** and **Firefox AMO** (extension `0.1.66`).

## Pending

- More data sources (community, API-verified) published to the registry.
- HTTP → consumer ingest endpoints; Firefox Drive OAuth redirect at store review.
