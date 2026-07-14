# Sources roadmap

Backlog of services we want as Habeas **sources**. These are *targets*, not adapters yet — a source
is only real once it is **authored from a real in-session capture** (record mode) and
**API-verified** against the live service, then validated and published to
[habeas-dev/sources](https://github.com/habeas-dev/sources). We never ship fabricated/guessed
adapters (invented endpoints or fields). Fictional shapes live only in `extension/test/fixtures/`.

## How each target becomes a real source

1. On a device logged in to the service, open the extension → **Create a source** (record mode).
2. Browse your data (orders / invoices / movements) so Habeas observes the real API calls.
3. **Analyze** → review the auto-drafted `itemsPath`, pagination and field mapping in the mapper.
4. **Test** → confirm 3 sample docs come back. Fix the mapping / schema / category as needed.
5. **Save**, then **Share** → opens a prefilled PR to `habeas-dev/sources`. CI validates (schema +
   same-domain guard). Merge → it appears in the marketplace.

Same-domain guard: if the service replays the session to a different registrable domain (common for
Revolut/Trade Republic), declare it in `crossDomainHosts` — the extension shows an off-site consent
screen. Financial sources are welcome from the community under this guard (trust label, not a block).

## Backlog

Status: `todo` = needs capture · `draft` = recorded, not verified · `live` = published.

**Published so far (11):** `carrefour-es`, `dia-es`, `hover-com`, `decathlon-es`, `bipdrive-es`,
`leroymerlin-es`, `wizink-es`, `caixabank-consumer-es`, `ikea-es`, `amazon-es`, `ing-es`.

| # | Service | Login domain | Category | Schema | Status | Notes |
|---|---|---|---|---|---|---|
| 0 | Carrefour | carrefour.es | grocery/fuel/retail | receipt | **live** | `carrefour-es`, first-party, shipped |
| 1 | Dia | dia.es | grocery/retail | receipt | **live** | `dia-es` |
| 2 | Hover | hover.com | retail/service | receipt | **live** | `hover-com`, domain registrar receipts |
| 3 | Ikea | ikea.es | retail | receipt | **live** | `ikea-es` |
| 4 | Decathlon | decathlon.es | retail | receipt | **live** | `decathlon-es` |
| 5 | Leroy Merlin | leroymerlin.es | retail | receipt | **live** | `leroymerlin-es` |
| 6 | Amazon | amazon.es | retail | receipt | **live** | `amazon-es` |
| 7 | Bip&Drive | bipandrive.com | mobility/toll | invoice | **live** | `bipdrive-es`, tolls/parking |
| 8 | Wizink | wizink.es | card | transaction | **live** | `wizink-es`, multi-output (movimientos + extractos PDF/Excel) |
| 9 | CaixaBank Consumer | caixabank.es | card/financing | invoice | **live** | `caixabank-consumer-es`, financing statements (extractos) |
| 10 | ING | ing.es | bank/card | transaction | **live** | `ing-es`, 3 streams: transactions + per-account statements (PDF/Excel) + integrated statement (PDF) |
| 11 | Obramat | obramat.es | retail | receipt | todo | ex-Bricomart |
| 12 | Telepizza | telepizza.es | food/retail | receipt | todo | |
| 13 | AliExpress | aliexpress.com | retail | receipt | todo | strong anti-bot |
| 14 | Pepe Energy | pepeenergy.com | utility | invoice | todo | electricity |
| 15 | Pepephone | pepephone.com | telco | invoice | todo | mobile |
| 16 | Financiera El Corte Inglés | elcorteingles.es | card | transaction | todo | store card / financing |
| 17 | Openbank | openbank.es | bank/card | transaction | todo | PSD2 is the canonical path; Habeas covers the gaps |
| 18 | Revolut | revolut.com | card | transaction | todo | likely cross-domain (app.revolut.com/api) → off-site consent |
| 19 | Trade Republic | traderepublic.com | investment | investment | todo | WebSocket API — extra work |
| 20 | Raisin | raisin.es | investment | investment | todo | deposits/savings |

## Notes by group

- **Retail:** simplest — `receipt@1`, usually same-domain, often a PDF/ticket per order. Best first
  cases after Carrefour; Ikea, Decathlon, Leroy Merlin, Dia and Amazon are now live. AliExpress
  remains hard (anti-bot, no clean order API).
- **Utility / telco / toll:** recurring PDF invoices → `invoice@1`. Bip&Drive (live) uses a
  `toll`/`mobility` category — categories are just strings the adapter declares. Pepe Energy /
  Pepephone still `todo`.
- **Cards & financial:** allowed from the community under the same-domain guard + consent. Proper
  banks (ING — live — Openbank, CaixaBank) — PSD2 AIS is the sanctioned aggregation path; Habeas
  adds what PSD2 handles poorly (specific card movements, financing, investments). ING and WiZink are
  the reference multi-stream/multi-output financial sources. Revolut / Trade Republic are
  cross-domain and/or non-REST → expect `crossDomainHosts` and extra runtime work.

## Runtime gaps this backlog may surface

- A `toll`/`mobility` category (Bip&Drive) — trivial (declare it).
- Trade Republic's WebSocket transport — the current runtime assumes REST `fetch`; may need a new
  transport in `runtime/inventory.js`. Defer until we actually capture it.
