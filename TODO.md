# Habeas — TODO

* Caixabankconsumer: le digo que descargue todo de nuevo y no me trae ningún PDF. Aparece "[object Object]" en el campo Tienda.
* Al seleccionar un nuevo source se me pone, por defecto, el primer sink configurado. Deberíamos poder seleccionar un sink favorito
* Echo de menos Google drive como lugar para establecer el almacén canónico
* Leroymerlin: no aparecen las compras online
* En general: no se autodetecta cuando he hecho login. Si le doy a "Listar documentos" y se me abre una ventana y hago login, esperaría que Habeas detectara el momento en el que he hecho login y listara los documentos según lo esperado.

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
