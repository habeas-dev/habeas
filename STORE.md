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

Both stores search over the **title and description**. A bare "Habeas" matches nothing anybody
types, so the title carries the documents; the brand still leads because it is the product's name.

**EN** (CWS allows 45 chars) — **live on AMO since 2026-08-08**:
> Habeas — export receipts & invoices

**ES**:
> Habeas — descarga tickets y facturas

## Short description / summary

**EN** (≤132 chars CWS / ≤250 AMO) — **live on AMO since 2026-08-08**:
> Download your own receipts, invoices and bank statements from services that offer no export — inside your own already-signed-in session. Open source, no stored passwords.

Shorten to fit the CWS 132-char limit:
> Download your own receipts, invoices and bank statements from sites with no export — in your own session. Open source.

**ES**:
> Descarga tus tickets, facturas y extractos de servicios que no lo permiten — en tu propia sesión. Código abierto.

> **Both stores support localised listings.** Publish the ES text under `es`/`es-ES`, not instead of
> the English: every published source is Spanish, so that is where the demand is, but the default
> listing is what most of the world sees.

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

## ⚠️ Policy note — do NOT list supported brands (CWS rejection, 2026-08-11)

The Chrome Web Store **rejected** a submission for *keyword spam* (ref. `Yellow Argon`), quoting the
run of ~24 brand names the listing used to carry ("Carrefour, Dia, IKEA, … Raisin and Hover"). Their
rule: metadata must be **descriptive**, not a keyword list.

So the listing describes **kinds of service** (supermarkets, banks and card issuers, brokers, utilities…)
and links to https://habeas.dev/sources.html for the actual catalog. That is also where the catalog
belongs: it changes every week, and a store listing can't track it anyway.

**Do not re-add the brand list**, however tempting it is for search. It is what got the extension
rejected, and re-adding it risks a harsher action than a rejection. Competitor names (Plaid, Tink…)
were removed for the same reason — not flagged this time, but the same policy.

The one place brands legitimately appear is the **screenshots**, since they show the product doing real
work. If a review ever objects there too, the fix is to capture with sources whose brand is ours or
generic, not to argue.

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
> **Works today with:** supermarkets and retail chains, banks and card issuers, payment services,
> brokers, utilities and telecoms, and toll and mobility providers — plus any source the community
> adds. The current catalog lives at https://habeas.dev/sources.html
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
> **Funciona ya con:** supermercados y cadenas de tiendas, bancos y emisores de tarjetas, servicios
> de pago, brókers, suministros y telecos, y peajes y movilidad — además de las fuentes que aporte la
> comunidad. El catálogo actual está en https://habeas.dev/sources.html
>
> Habeas ejerce tu derecho de portabilidad (GDPR Art. 20) sobre tus propios datos, con software que
> ejecutas tú. Los Términos de cada servicio pueden restringir el acceso automatizado — cumplirlos es
> tu responsabilidad.
>
> Código abierto: https://github.com/habeas-dev/habeas · Privacidad: https://habeas.dev/privacy.html

---

## CWS paste-ready block (plain text — the Chrome Web Store does not render Markdown)

**Title (45 max) — 35 chars**
```
Habeas — export receipts & invoices
```

**Summary (132 max) — 118 chars**
```
Download your own receipts, invoices and bank statements from sites with no export — in your own session. Open source.
```

**Description**
```
Habeas — reclaim your own data, in your own session

Many services hold data that is yours — receipts, invoices, card, bank or investment movements — behind walls you can't automate (Cloudflare, Akamai…), with neither an API nor an export. Habeas gives it back to you.

Unlike server-side scraping, Habeas runs inside your real browser, in your already signed-in session. Because of that:
• It never fights anti-bot systems: it inherits your valid session.
• It never stores your passwords. You log in yourself; the token lives only in memory and is cleared when you close the browser.
• You solve MFA/OTP live, exactly as you always do.

It's the opposite of how server-side account aggregators operate.

WORKS TODAY WITH
Supermarkets and retail chains, banks and card issuers, payment services, brokers, utilities and telecoms, and toll and mobility providers — and any source the community adds. See the current catalog at https://habeas.dev/sources.html

YOUR ARCHIVE, MADE VISUAL
Everything you recover lands in your Archive: a clear view of your documents, laid out in a source → account tree, with cards grouped by month or category, amounts and status. Search, filter by account, and open any saved document.

YOU DECIDE WHERE YOUR ARCHIVE LIVES
By default it is stored locally in this browser. With one click you can move it to the cloud to reach it from several devices — Dropbox, Google Drive, WebDAV, S3, or a local folder. You can also send specific documents to a destination: a download, a local folder, or an HTTP endpoint you configure. Nothing leaves your browser until you choose a destination.

SOURCES ARE DATA, NOT CODE
Sources are declarative definitions — no remotely-hosted code, honoring MV3's rules. There are audited first-party sources and a growing community catalog. Missing a service? Record mode watches the site's own API as you browse and drafts the source for you, no coding needed, and you can share it with the community.

PRIVACY AND CONTROL, BY DESIGN
• Local-first and open source (AGPL-3.0): you can audit exactly what it does.
• Domain-bound trust boundary: a source's captured session can only ever be replayed to its own service; crossing domains requires an explicit allow-list and a consent screen.
• Integrations on your terms: a website can propose a data flow, but nothing runs until you approve it — and only back to that same site. Revocable anytime.

YOUR RIGHT, YOUR DATA
Habeas rests on your right to data portability (GDPR Art. 20) and the principle of habeas data: it is your own data, in your own session, through free software you run yourself. Habeas is not a PSD2-regulated actor (it initiates no payments). Each site's terms of service may restrict automated access; complying with them is your responsibility.

No telemetry · no accounts · no stored passwords.

Open source: https://github.com/habeas-dev/habeas
Privacy: https://habeas.dev/privacy.html
```

### Spanish localised listing

Chrome takes the **title and summary** from the package (`_locales/es/messages.json`), so those two are
already localised and are NOT editable in the console. Only the **description** has to be pasted by hand
in the console's Spanish listing.

**Description (ES)**
```
Habeas — recupera tus propios datos, en tu propia sesión

Muchos servicios guardan datos que son tuyos —tickets, facturas, movimientos de tarjeta, banco o inversión— tras muros que no puedes automatizar (Cloudflare, Akamai…), sin API ni exportación. Habeas te los devuelve.

A diferencia del scraping desde un servidor, Habeas funciona dentro de tu navegador real, en tu sesión ya iniciada. Gracias a eso:
• Nunca pelea con los sistemas anti-bot: hereda tu sesión válida.
• Nunca guarda tus contraseñas. Inicias sesión tú; el token vive solo en memoria y se borra al cerrar el navegador.
• Resuelves el MFA/OTP en directo, exactamente como haces siempre.

Es lo contrario de como operan los agregadores que trabajan desde sus servidores.

FUNCIONA YA CON
Supermercados y cadenas de tiendas, bancos y emisores de tarjetas, servicios de pago, brókers, suministros y telecos, y peajes y movilidad — y cualquier fuente que aporte la comunidad. Consulta el catálogo actual en https://habeas.dev/sources.html

TU ARCHIVO, DE FORMA VISUAL
Todo lo que recuperas aterriza en tu Archivo: una vista clara de tus documentos, ordenados en un árbol de fuente → cuenta, con tarjetas agrupadas por mes o categoría, importes y estado. Busca, filtra por cuenta y abre cualquier documento guardado.

TÚ DECIDES DÓNDE VIVE TU ARCHIVO
Por defecto se guarda localmente en este navegador. Con un clic puedes moverlo a la nube para llegar a él desde varios dispositivos: Dropbox, Google Drive, WebDAV, S3 o una carpeta local. También puedes enviar documentos concretos a un destino: una descarga, una carpeta local o un endpoint HTTP que configures. Nada sale de tu navegador hasta que eliges un destino.

LAS FUENTES SON DATOS, NO CÓDIGO
Las fuentes son definiciones declarativas, sin código alojado en remoto, respetando las reglas de MV3. Hay fuentes auditadas por el proyecto y un catálogo comunitario en crecimiento. ¿Te falta un servicio? El modo grabación observa la propia API del sitio mientras navegas y te redacta la fuente, sin programar, y puedes compartirla con la comunidad.

PRIVACIDAD Y CONTROL, DESDE EL DISEÑO
• Local-first y código abierto (AGPL-3.0): puedes auditar exactamente qué hace.
• Frontera de confianza por dominio: la sesión capturada de una fuente solo puede reutilizarse contra su propio servicio; cruzar dominios exige una lista blanca explícita y una pantalla de consentimiento.
• Integraciones en tus términos: una web puede proponer un flujo de datos, pero nada se ejecuta hasta que lo apruebas, y solo de vuelta a esa misma web. Revocable cuando quieras.

TU DERECHO, TUS DATOS
Habeas se apoya en tu derecho a la portabilidad de datos (RGPD, art. 20) y en el principio de habeas data: son tus propios datos, en tu propia sesión, con software libre que ejecutas tú. Habeas no es un actor regulado por la PSD2 (no inicia pagos). Los términos de servicio de cada web pueden restringir el acceso automatizado; cumplirlos es tu responsabilidad.

Sin telemetría · sin cuentas · sin contraseñas guardadas.

Código abierto: https://github.com/habeas-dev/habeas
Privacidad: https://habeas.dev/privacy.html
```

---

## Keeping the listings in sync

**AMO is done and de-branded** (listing updated 2026-08-11). Note that AMO's *detailed description* is
richer than the one in this file — it covers the Archive, the cloud store, record mode and the
domain-bound trust boundary. **Do not overwrite it with the copy above**; the text here is the shorter
CWS-oriented version. Read the live one at `addons.mozilla.org/en-US/developers/addon/habeas/edit`
before changing either. The brand list and the named competitors were removed there too, surgically —
Mozilla had not objected, but the text is the same and there is no reason to keep the exposure.

**CWS must be redone BY HAND** after the rejection: paste the corrected description from the block
above. It cannot be automated — Chrome forbids extensions from scripting the web-store origin, and the
developer console lives there.

Remember that saving a listing change **resubmits the item for review** in both stores.

**⛔ The brand list this section used to tell you to regenerate is exactly what got the CWS submission
rejected** (see the policy note at the top). The old rationale — that listing "carrefour", "ing" or
"pepephone" makes in-store search surface Habeas — is true and is precisely why the policy forbids it:
that is the definition of keyword spam. **Do not regenerate it, and do not paste it into any listing.**

Both stores now describe *kinds* of service and link to https://habeas.dev/sources.html, which is the
only copy of the catalog that can stay current anyway. If a source is published, nothing in the store
listings needs to change.

Store ranking also weighs installs and ratings, and both listings currently sit near zero reviews.
Neither store allows soliciting reviews inside the extension, so this only moves once real users
arrive — which is what the landing pages and the launch posts are for.

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
