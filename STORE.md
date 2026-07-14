# Store listing kit — Habeas

Copy-paste material for the **Chrome Web Store** and **Firefox Add-ons (AMO)**. The same
`dist/habeas-<version>.zip` (built by CI on `v*` tags) is uploaded to both.

- Homepage: https://habeas.dev
- Privacy policy: https://habeas.dev/privacy.html
- Terms of Service: https://habeas.dev/terms.html
- Source: https://github.com/habeas-dev/habeas
- Support: open an issue on GitHub

---

## Name

**Habeas** (optionally, where a tagline fits: **Habeas — reclaim your own data**)

## Short description / summary

**EN** (≤132 chars, Chrome Web Store): 
> Export your own receipts, invoices and transactions from sites that hide them — in your own browser session. Local-first, open-source.

**ES**: 
> Exporta tus tickets, facturas y transacciones de servicios que no lo permiten — en tu propia sesión. Local-first y de código abierto.

## Category

- **Chrome Web Store:** Productivity
- **Firefox AMO:** Privacy & Security  (alt: Other)

## Single-purpose description (Chrome Web Store requires one)

> Habeas has a single purpose: to let a user export **their own** personal documents (receipts,
> invoices, card and investment records) from online services that offer no API or bulk export, by
> reading them through each service's own web API inside the user's already-authenticated browser
> session, and delivering them to a destination the user chooses (a download, a local folder, their
> own Google Drive or Dropbox, an HTTP endpoint they configure, or a WebDAV / S3-compatible store).

---

## Detailed description

**EN**

> **Your data is yours. Getting it out isn't.** Many services — supermarkets, utilities, banks —
> make bulk export of your own receipts, invoices and transactions practically impossible: no API,
> no email export, and a web interface guarded by anti-bot walls.
>
> **Habeas** is a free, open-source (AGPL-3.0) extension that extracts **your own** data from those
> services — entirely inside your own, already-authenticated browser session.
>
> • **In your own session.** It runs after *you* log in yourself (MFA included). It never stores,
>   transmits, or autofills your passwords, and there is no server-side login and no background
>   scraping while you're away.
> • **Local-first.** Your documents and your session never leave your browser unless you pick a
>   destination. The project runs no servers and never receives your data.
> • **You choose where it goes:** a download, a local folder, your **own** Google Drive (only files
>   Habeas creates — it can't see your other files) or Dropbox, an HTTP endpoint you configure (e.g. a
>   personal-finance app you use), or a WebDAV / S3-compatible store you control.
> • **Declarative, auditable sources.** Each service is described by data, not code — open to
>   community contributions and reviewed in the open. No remotely-hosted code, ever.
> • **No trackers.** No analytics, no telemetry, self-hosted fonts.
>
> Habeas exercises your GDPR Art. 20 right to data portability, on your own data, with software you
> run. Each service's Terms may restrict automated access — complying with them is your
> responsibility.
>
> Open source: https://github.com/habeas-dev/habeas · Privacy: https://habeas.dev/privacy.html

**ES**

> **Tus datos son tuyos. Sacarlos, no tanto.** Muchos servicios —supermercados, suministros,
> bancos— hacen casi imposible exportar en bloque tus propios tickets, facturas y movimientos: sin
> API, sin exportación por email y con una web protegida por muros anti-bot.
>
> **Habeas** es una extensión libre y de código abierto (AGPL-3.0) que extrae **tus propios** datos
> de esos servicios, íntegramente dentro de tu propia sesión ya autenticada.
>
> • **En tu propia sesión.** Funciona después de que inicies sesión *tú* (MFA incluido). Nunca
>   guarda, transmite ni autocompleta tus contraseñas; no hay login en servidor ni scraping en
>   segundo plano mientras no estás.
> • **Local-first.** Tus documentos y tu sesión no salen del navegador salvo que elijas un destino.
>   El proyecto no tiene servidores y nunca recibe tus datos.
> • **Tú eliges el destino:** descarga, carpeta local, tu **propio** Google Drive (solo los ficheros
>   que Habeas crea — no puede ver los demás) o Dropbox, un endpoint HTTP que configures, o un almacén
>   WebDAV / compatible con S3 que controles.
> • **Fuentes declarativas y auditables.** Cada servicio se describe con datos, no con código —
>   abiertas a la comunidad y revisadas en abierto. Nunca código remoto.
> • **Sin rastreadores.** Sin analítica ni telemetría; fuentes tipográficas propias.
>
> Habeas ejerce tu derecho de portabilidad (GDPR Art. 20) sobre tus propios datos, con software que
> ejecutas tú. Los Términos de cada servicio pueden restringir el acceso automatizado — cumplirlos es
> tu responsabilidad.

---

## Permission justifications (for review / the CWS "Privacy practices" tab)

| Permission | Why it's needed |
|---|---|
| `storage` | Save the user's settings, a delivery ledger (to avoid re-downloading), and a local activity log on the device. Session tokens live in `storage.session` (memory only, cleared on close). |
| `downloads` | The "Download" destination — save an exported document as a file. |
| `identity` | Google Drive destination only: `launchWebAuthFlow` OAuth to the user's **own** Drive, `drive.file` scope (only files the extension creates). |
| `notifications` | Notify the user when new documents were synced (auto mode). |
| `scripting` | Run the data fetch **in the site's own tab (page context)** so it inherits the user's session and passes anti-bot walls; and, in opt-in "record mode", capture sample responses to draft a new source. |
| `declarativeNetRequestWithHostAccess` | Set the `Referer` header on requests to endpoints that require it (a header `fetch` cannot set). Header-only, per-request, never blocks or redirects. |
| `host_permissions` (specific first-party hosts) | Read the user's data from the services shipped as built-in sources, using the session already in the browser. |
| `optional_host_permissions: https://*/*` | **Requested at runtime, per origin, with the user's click** — only for community/record-mode sources the user chooses to add. Not granted up front. |

**Data usage disclosures (Chrome "Privacy practices"):**
- The extension handles the user's **own** data and delivers it **only** to a destination the user
  selects. It is **not** sent to the developer. **No** data is sold or used for purposes unrelated to
  the single purpose. **No** creditworthiness/lending use. Personal communications are not accessed.
- Google user data (Drive): used solely to upload the user's exported documents to their own Drive;
  not transferred to third parties; not used for ads or model training. Complies with the Google API
  Services User Data Policy (Limited Use).

## Notes for reviewers

- **Adapters are data, not code** — sources are declarative JSON/JS objects; there is **no
  remotely-hosted or eval'd code** (MV3-compliant). Community sources install as data.
- **Same-registrable-domain guard:** a source can only replay the captured session to the **same
  eTLD+1** it was captured from; cross-domain needs an explicit allowlist + a consent screen. Silent
  credential exfiltration is structurally prevented.
- **No credential handling:** the user logs in themselves; only the live session token is used, in
  memory.
- `optional_host_permissions: https://*/*` exists so a user can point **record mode** at a service of
  their choice; the permission is requested interactively for that one origin, never pre-granted.
- Firefox: web-ext lint warns that `service_worker` is ignored by Firefox — expected (the manifest is
  dual-target; Firefox uses `background.scripts`). `browser_specific_settings.gecko.id =
  habeas@habeas.dev`, `strict_min_version 128.0`, `data_collection_permissions: none`.

---

## Screenshots to capture (1280×800 recommended; ≥1, up to 5)

1. **The popup** listing a source's documents (e.g. Carrefour/Dia receipts) with dates and totals.
2. **Settings → Sources** (the tabbed options page) showing an installed source.
3. **Settings → Destinations** showing Download / Local folder / Google Drive / HTTP / WebDAV / S3 / Dropbox.
4. **Record mode / author** — drafting or testing a source (the visual mapper with test rows).
5. **Site integrations** — the consent/authorize screen or the granted-integrations list.

Tip: use a real, non-sensitive account and blur any personal identifiers. A 440×280 (CWS) or
promotional tile can reuse the hero from habeas.dev.

## Store URLs (live — the site's install buttons point here)

- Chrome Web Store: `https://chromewebstore.google.com/detail/pbpehhngeidokhaokgloaneiibhceiog`
- Firefox Add-ons:  `https://addons.mozilla.org/firefox/addon/habeas/`
