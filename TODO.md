# Habeas — TODO

* [DONE v0.1.58.1] ~~Falta la opción o acción de la extensión para ejecutar un barrido secuencial por todas
  las sources configuradas para extraer todos los documentos nuevos en modo automático (primero desatendido
  sin pestaña, y solo acudir a una pestaña si falla o requiere atención).~~ Added a **"Sync all"** button in
  the popup topbar → `background.js#sweepAllSources`: sweeps every `mode:auto` route sequentially, tries each
  UNATTENDED first (existing tab if any, else direct fetch), and only on a session/anti-bot failure opens the
  source tab and retries in-session (`needsTabEscalation` in `lib/autosync.js`, unit-tested). Bypasses the
  per-route debounce; one summary notification + activity-log entry.

* [DONE v0.1.58.2/.3/.4] ~~Crear varios sink más: Dropbox, WebDAV y S3.~~ All three added, each with the
  cumulative per-source manifest and selectable for auto routes / Sync all. Need live smoke tests.
  * [DONE v0.1.58.2] WebDAV — `sinks.js#webdav`: PUT (MKCOL parents) + Basic auth (password in secrets).
  * [DONE v0.1.58.3] S3 — `sinks.js#s3` + pure `lib/sigv4.js` (verified vs AWS's vector); AWS + compatible
    (MinIO/R2/B2) via custom endpoint; access key inline + secret in the secrets store.
  * [DONE v0.1.58.4] Dropbox — `sinks/dropbox.js`: public app (PKCE) refresh-token model → silent access-
    token renewal, upload via the content API. No redirect URI (sidesteps Firefox's per-install UUID).

* [DONE v0.1.53.5] ~~Caixabankconsumer: aparece "[object Object]" en el campo Tienda.~~ Fixed: nested
  `{name}` (invoice issuer / receipt store) now resolves to a display string, live + from store.
* Caixabankconsumer: "descargar todo de nuevo" no trae PDF. **Capture confirmed the adapter is CORRECT**
  (list `…/extractos/consultaonline` → `itemsPath:"Extractos"`; each item's `Url` IS the absolute PDF URL;
  the PDF GET just needs the `authorization` bearer, which is replayed). So it's not a mapping bug — it's
  the store-projection (incremental List shows records-only rows with no URL → **use Full history** to
  re-fetch PDFs) and/or the already-shipped `[object Object]` + direct-fetch (CSP) fixes. Re-test on 0.1.54.
  (Optional future: persist the PDF URL in the store record so records-only rows can still fetch it.)
  * [DONE v0.1.60.1] ~~Persist the PDF URL in the store record~~ — `buildRecord` writes `record.pdfUrl`
    for `pdf.urlField` sources; `artifactKinds`/`fetchArtifact` fall back to it for store rows (no `_raw`),
    re-validating the host each fetch (`assertAllowedDocHost`). Unit-tested.
* [DONE v0.1.53.5] ~~Al seleccionar un nuevo source se pone el primer sink. Sink favorito.~~ Fixed: the sink
  chosen for a source is remembered (storage.local `habeas:favsink`) and pre-selected next time.
* [DONE v0.1.53.7] ~~Echo de menos Google drive como almacén canónico.~~ Added a `drive` store backend
  (`lib/store/drive.js` → `sinks/drive.js#driveStore`), selectable in Settings; per-source JSON at
  `Habeas/_store/<source>.json`. Unit-tested against a faked Drive REST layer. **Needs a live-Drive smoke
  test** (OAuth can't run in node) before relying on it.
* [DONE v0.1.53.10] ~~Leroymerlin: no aparecen las compras online.~~ Capture found online orders at
  `GET /order-followup/backend/v2/orders` (bare array, mixes ONLINE/IN_STORE). `leroymerlin-es` is now
  multi-stream: `tickets` (in-store receipts, existing) + `pedidos` (online orders, `itemsPath:"$"` +
  `keep:{orderPlaceType:[ONLINE]}`). Verified against the real captured response.
* [DONE v0.1.53.6 bearer / v0.1.53.8 cookie] ~~No se autodetecta el login.~~ Bearer sources resume when the
  token is captured; cookie sources (WiZink) retry the list on the next popup open (arm-on-login-failure +
  pending marker), without disturbing a half-entered login on retry.

## External hooks — manual / e2e validation (pending)

The security-critical logic is unit-tested (origin-bound rejection, `validateProposal`, grant→origin
binding) and the existing e2e suite is green, but the **live interactive flow is browser-behaviour
heavy and not yet covered by e2e**. Needs a manual pass (or a dedicated https e2e):

- [ ] Build an **https test page** that calls `propose-workflow` (see `consumers/external-hooks.md`):
  - [ ] origin-bound OK (sink URL host == page origin) → consent screen opens → **Allow** → grant created.
  - [ ] cross-origin sink (different host) → rejected outright (`status:'denied'`, no side effects).
  - [ ] unlisted/any origin still reaches the bridge (no allowlist) — confirm it works from a fresh origin.
- [ ] `collect` on the granted Carrefour route:
  - [ ] with a live session → runs in a background dedicated tab, delivers to the sink.
  - [ ] with no session → source login tab is **foregrounded**; after the user logs in, it resumes and delivers.
  - [ ] re-run sends only NEW docs (ledger dedupe holds); debounce blocks rapid repeats.
- [ ] **Settings → Site integrations**: the grant is listed and **Revoke** removes it.
- [ ] Confirm no path stores/forwards credentials; no path delivers to an origin other than the caller's.

Caveats to check during that pass:
- [x] The `https://*/*` content script (extbridge) adds an **"all sites" permission warning** at install
      — the accepted cost of "anyone can propose". Accepted; the extension is now published on both stores.
- [ ] For sources **other than Carrefour**, in-tab capture depends on injecting the hook
      (`executeScript`, best-effort) + host permission for that domain — verify with a 2nd source.
- [ ] MV3 store review: justify `scripting` + the broad content script + `optional_host_permissions`.

## Other pending (from CLAUDE.md roadmap)
- [~] Author real sources via record mode / community PRs, API-verified; publish to the registry.
  **11 published** so far: carrefour-es, dia-es, hover-com, decathlon-es, bipdrive-es, leroymerlin-es,
  wizink-es, caixabank-consumer-es, ikea-es, amazon-es, **ing-es** (3-stream: movimientos + per-account
  monthly statements PDF/Excel + integrated monthly statement PDF). Keep growing the catalog.
- [ ] HTTP → Tiquetera ingest endpoint (POST normalized records + PDFs; pairing token).
- [x] Encrypt secrets at rest — DONE (`lib/secrets.js` AES-GCM envelopes keyed by a non-extractable
  IndexedDB CryptoKey; sink pairing-token headers + the Drive OAuth token also encrypted).
- [x] Harden dynamic HTML — DONE (all dynamic values in `ui/popup.js`/`ui/options.js` escaped via
  shared `lib/esc.js`; web-ext still flags `innerHTML` structurally but no unescaped sink remains).
- [x] AMO + Chrome Web Store submission — AMO **approved & live**; CWS published (public beta).
  Firefox Drive OAuth redirect still shown in Settings for users to register on their own client.
- [ ] Optional: CF secrets in `habeas-dev/api` for CI auto-deploy.

## Done since (0.1.59 → 0.1.66)
- [DONE] Delivery sinks **Dropbox, WebDAV, S3** (+ S3-compatible: MinIO/R2/B2) — also available as
  canonical-store backends (`lib/store/{dropbox,webdav,s3}.js`); store backends now: local(IndexedDB),
  folder, http, drive, dropbox, webdav, s3.
- [DONE] **ING España** source (`ing-es`, 3 streams/outputs) published to the registry.
- [DONE] Persistent per-account filter for grouped bank sources.
- [DONE] **"Documents" tab** in the popup — cross-source browser of everything recovered, with a JSON
  schematic viewer (`ui/docview.js`) and open-delivered-file; plus a canonical-store inspector with
  delete (`ui/store-browser.js`).
- [DONE] Light **declarative data-normalization layer** (`lib/normalize.js`) — counterparty extraction
  + a uniform canonical output shape, **opt-in per sink**; `record.extra` keepRaw preserves every raw
  field of a movement; currency parsing no longer forces EUR.
- [DONE] `habeas.dev/sources.html` catalog is now statically **pre-rendered** (works without JS) and
  auto-refreshed by a scheduled workflow.
