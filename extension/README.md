# Habeas extension (MV3) — skeleton

Real extension scaffold with the configuration layer from spec §6.9 and the validated
Carrefour datasource ported from the userscript prototype.

## Layout

```
extension/
├── manifest.json
└── src/
    ├── background.js          # stores captured session auth in storage.session (never on disk)
    ├── lib/
    │   ├── config.js          # datasources / sinks / routes  (storage.local, versioned JSON)
    │   ├── secrets.js         # sink credentials, SEPARATE store, referenced by secret://
    │   └── naming.js          # path templates {service}/{yyyy}/{date}-{externalId}.{ext}
    ├── adapters/
    │   └── carrefour-es.js    # adapter as data (host, endpoints, auth model, field map)
    ├── content/
    │   ├── bridge.js          # isolated: injects hook, relays captured auth to background
    │   └── hook.js            # page context: captures the user JWT + CSRF headers
    ├── runtime/
    │   └── inventory.js       # list all documents + fetch a PDF (uses captured auth)
    ├── sinks/
    │   └── sinks.js           # download · local-folder (FS Access) · drive (stub) · http
    └── ui/
        ├── popup.html/js      # inventory + "Enviar a ▾" (inline destinations, FR-33)
        └── options.html/js    # configure datasources & sinks
```

## What works now

- **Datasource Carrefour**: capture the user's session (JWT + CSRF) from carrefour.es and
  enumerate all documents; download each ticket PDF.
- **Sinks**: `download` and `local-folder` (File System Access — point it at a
  Drive/Dropbox-synced folder for "cloud" with no OAuth). `http` posts to a consumer.
- **Config**: enable datasources and add sinks from the options page; config in
  `storage.local`, secrets in a separate store, session token only in `storage.session`.

## Pending

- **Native Google Drive sink** — needs the project's own OAuth client (scope `drive.file`,
  which avoids Google's CASA assessment). The sink is stubbed until then.
- **Firefox packaging** — this loads in Chromium (dev: load unpacked). Firefox needs a
  background-script tweak and testing (Firefox-first is still the target for release).
- Encrypt secrets at rest; Route entity with `mode: auto`.

## Load it (Chromium, dev)

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick `extension/`.
2. Open the popup → **Ajustes** → activate the **Carrefour** datasource and add a sink
   (e.g. *Descargas* or *Carpeta local*).
3. Open `carrefour.es` → **Mis compras** (so the extension captures your session).
4. Open the popup → **Listar documentos** → select → **Enviar a**.

> Note: for `local-folder`, the folder picker can dismiss the popup on some setups; if so,
> use *Descargas* for now (the sink UX will move to a dedicated tab).
