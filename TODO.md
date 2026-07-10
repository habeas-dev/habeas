# Habeas — TODO

* [DONE v0.1.53.5] ~~Caixabankconsumer: aparece "[object Object]" en el campo Tienda.~~ Fixed: nested
  `{name}` (invoice issuer / receipt store) now resolves to a display string, live + from store.
* Caixabankconsumer: "descargar todo de nuevo" no trae PDF. **Needs a fresh capture to confirm.** Two
  likely causes: (a) listing incrementally shows STORE rows (records-only projection → no PDF re-fetch);
  use **Full history** to re-enumerate + re-fetch PDFs. (b) the `api.pdf.urlField:"Url"` may not match the
  real field — verify against a capture.
* [DONE v0.1.53.5] ~~Al seleccionar un nuevo source se pone el primer sink. Sink favorito.~~ Fixed: the sink
  chosen for a source is remembered (storage.local `habeas:favsink`) and pre-selected next time.
* [DONE v0.1.53.7] ~~Echo de menos Google drive como almacén canónico.~~ Added a `drive` store backend
  (`lib/store/drive.js` → `sinks/drive.js#driveStore`), selectable in Settings; per-source JSON at
  `Habeas/_store/<source>.json`. Unit-tested against a faked Drive REST layer. **Needs a live-Drive smoke
  test** (OAuth can't run in node) before relying on it.
* Leroymerlin: no aparecen las compras online. **Needs a capture** of the online-orders endpoint — the
  current `leroymerlin-es` source only lists in-store receipts; the online-orders API/shape is unknown.
* [DONE v0.1.53.6] ~~No se autodetecta el login.~~ Fixed for BEARER sources: List with no session opens the
  login tab and auto-resumes listing when the token is captured (live listener + pending marker on reopen).
  **Still pending for COOKIE sources** (WiZink): their session can't be detected via token capture — needs a
  different signal (watch the tab reaching a logged-in URL, or a post-login retry).

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
- [ ] The `https://*/*` content script (extbridge) adds an **"all sites" permission warning** at install
      — the accepted cost of "anyone can propose". Decide if acceptable for store submission.
- [ ] For sources **other than Carrefour**, in-tab capture depends on injecting the hook
      (`executeScript`, best-effort) + host permission for that domain — verify with a 2nd source.
- [ ] MV3 store review: justify `scripting` + the broad content script + `optional_host_permissions`.

## Other pending (from CLAUDE.md roadmap)
- [ ] Author real sources via record mode / community PRs, API-verified; publish to the registry.
- [ ] HTTP → Tiquetera ingest endpoint (POST normalized records + PDFs; pairing token).
- [ ] Encrypt secrets at rest; harden dynamic HTML (web-ext flags `innerHTML`).
- [ ] AMO + Chrome Web Store submission; Firefox Drive OAuth redirect.
- [ ] Optional: CF secrets in `habeas-dev/api` for CI auto-deploy.
