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

| # | Service | Login domain | Category | Schema | Status | Notes |
|---|---|---|---|---|---|---|
| 0 | Carrefour | carrefour.es | grocery/fuel/retail | receipt | **live** | first-party, shipped |
| 1 | Ikea | ikea.es | retail | receipt | todo | |
| 2 | Decathlon | decathlon.es | retail | receipt | todo | |
| 3 | Leroy Merlin | leroymerlin.es | retail | receipt | todo | |
| 4 | Obramat | obramat.es | retail | receipt | todo | ex-Bricomart |
| 5 | Telepizza | telepizza.es | food/retail | receipt | todo | |
| 6 | Amazon | amazon.es | retail | receipt | todo | strong anti-bot; no public order API |
| 7 | AliExpress | aliexpress.com | retail | receipt | todo | strong anti-bot |
| 8 | Bip&Drive | bipandrive.com | mobility/toll | invoice | todo | tolls/parking — new category `toll` |
| 9 | Pepe Energy | pepeenergy.com | utility | invoice | todo | electricity |
| 10 | Pepephone | pepephone.com | telco | invoice | todo | mobile |
| 11 | Wizink | wizink.es | card | transaction | todo | credit card |
| 12 | Financiera El Corte Inglés | elcorteingles.es | card | transaction | todo | store card / financing |
| 13 | CaixaBank (tarjetas) | caixabank.es | card | transaction | todo | cards only |
| 14 | Openbank | openbank.es | bank/card | transaction | todo | PSD2 is the canonical path; Habeas covers the gaps |
| 15 | ING | ing.es | bank/card | transaction | todo | idem PSD2 |
| 16 | Revolut | revolut.com | card | transaction | todo | likely cross-domain (app.revolut.com/api) → off-site consent |
| 17 | Trade Republic | traderepublic.com | investment | investment | todo | WebSocket API — extra work |
| 18 | Raisin | raisin.es | investment | investment | todo | deposits/savings |

## Notes by group

- **Retail (1–7):** simplest — `receipt@1`, usually same-domain, often a PDF/ticket per order. Best
  first cases after Carrefour. Amazon/AliExpress are the hardest (anti-bot, no clean order API).
- **Utility / telco / toll (8–10):** recurring PDF invoices → `invoice@1`. Bip&Drive needs a new
  `toll`/`mobility` category (categories are just strings the adapter declares).
- **Cards & financial (11–18):** allowed from the community under the same-domain guard + consent.
  Proper banks (ING, Openbank, CaixaBank) — PSD2 AIS is the sanctioned aggregation path; Habeas adds
  what PSD2 handles poorly (specific card movements, financing, investments). Revolut / Trade
  Republic are cross-domain and/or non-REST → expect `crossDomainHosts` and extra runtime work.

## Runtime gaps this backlog may surface

- A `toll`/`mobility` category (Bip&Drive) — trivial (declare it).
- Trade Republic's WebSocket transport — the current runtime assumes REST `fetch`; may need a new
  transport in `runtime/inventory.js`. Defer until we actually capture it.
