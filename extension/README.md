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
    ├── background.js          # captured auth (storage.session, never on disk) + auto-sync runner
    ├── lib/
    │   ├── ext.js             # cross-browser API shim (browser ?? chrome)
    │   ├── config.js          # datasources / sinks / routes  (storage.local, versioned JSON)
    │   ├── secrets.js         # sink credentials, SEPARATE store, referenced by secret://
    │   ├── state.js           # delivery ledger (dedupe) + activity log
    │   ├── fs.js              # File System Access directory handles (IndexedDB)
    │   ├── zip.js             # minimal store-only ZIP writer
    │   ├── naming.js          # path templates {service}/{yyyy}/{date}-{internalId}.{ext}
    │   ├── badge.js           # toolbar badge states (working/count/error)
    │   ├── theme-icon.js      # light/dark toolbar icon
    │   └── i18n.js            # applyI18n() + t()
    ├── adapters/              # carrefour-es.js (data, not code) + index.js catalog
    ├── content/               # bridge.js (isolated) + hook.js (page): capture JWT + CSRF
    ├── runtime/inventory.js   # enumerate documents + fetch a PDF
    ├── sinks/                 # sinks.js · format.js · drive.js (native Google Drive)
    └── ui/                    # popup (app tab) + options + theme.css
```

## Features

- **Data source: Carrefour España** — captures your session (JWT + CSRF) and enumerates all
  documents; downloads each ticket PDF. Old tickets Carrefour no longer retains are exported
  as metadata (in the manifest) only.
- **Destinations:** `download` (one ZIP + manifest), `local-folder` (File System Access —
  Chromium; point it at a synced folder for cloud), **`drive`** (native Google Drive,
  OAuth `drive.file`), `http` (POST to your own endpoint).
- **Inventory** with *new* / *already-sent* marks and per-sink **dedupe**; select New/All/None.
- **Automatic mode:** when you log in, new documents sync to a Drive/HTTP destination
  (desktop notification + activity log).
- **Config** in `storage.local`, secrets in a separate store, session token only in
  `storage.session`; UI in English/Spanish.

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

## Pending

- Encrypt secrets at rest; harden dynamic HTML (AMO review flags `innerHTML`).
- More data sources; AMO / Chrome Web Store submission.
