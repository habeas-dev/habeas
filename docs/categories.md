# Category catalog

Every Habeas source classifies each document with a **category**, used for **sink compatibility**
(a sink may declare `accepts: { categories: [...] }` to take only some kinds — e.g. a grocery app).

Categories are a **closed vocabulary**: a source may only emit the values below. This is enforced in
`extension/src/adapters/validate.js` (`CATEGORIES`, the single source of truth), mirrored by the
JSON Schema `categories` enum and the registry CI. To add a category, extend that array (and this
table + the schema enum), and open a PR.

A source declares the categories it can emit in `categories: [...]`, and optionally maps each
document to one via `categorize: { field, map: { <value>: <category> }, default: <category> }`
(all map/default values must also be in the catalog). Without `categorize`, every document gets
`categories[0]`.

## Retail purchases (typically `receipt@1`)

| Category | For |
|---|---|
| `grocery` | Supermarkets, food shopping |
| `fuel` | Refuelling / petrol stations |
| `sports` | Sporting goods (e.g. Decathlon) |
| `fashion` | Clothing, footwear, accessories |
| `electronics` | Consumer tech, appliances |
| `home` | Furniture, décor, homeware (e.g. Ikea) |
| `diy` | Hardware, building materials, garden (e.g. Leroy Merlín, Obramat) |
| `pharmacy` | Pharmacy, drugstore, health & beauty |
| `restaurant` | Dining, food delivery, takeaway (e.g. Telepizza) |
| `marketplace` | General online marketplaces (e.g. Amazon, AliExpress) |
| `travel` | Flights, hotels, transport tickets |
| `entertainment` | Events, streaming, games, culture |
| `retail` | Other retail (generic fallback) |

## Services (typically `invoice@1`)

| Category | For |
|---|---|
| `energy` | Electricity, gas (e.g. Pepe Energy) |
| `water` | Water utility |
| `telecom` | Phone, internet, TV (e.g. Pepephone) |
| `utility` | Other/generic utility |
| `tolls` | Road tolls, parking (e.g. Bip&Drive) |
| `transport` | Public transport, mobility |
| `insurance` | Insurance premiums |
| `subscription` | Memberships, SaaS |
| `domains` | Domain names & hosting (e.g. Hover, GoDaddy, Namecheap) |
| `education` | Tuition, courses |
| `healthcare` | Medical, dental services |
| `government` | Taxes, public fees |

## Financial (typically `transaction@1` / `investment@1`)

| Category | For |
|---|---|
| `card` | Card transactions (e.g. WiZink, El Corte Inglés Financiera) |
| `cash` | Cash withdrawals |
| `banking` | Bank account movements (e.g. Openbank, ING, CaixaBank) |
| `investment` | Securities, funds, brokerage (e.g. Trade Republic, Revolut) |
| `pension` | Pension plans |
| `crypto` | Crypto assets |
| `loan` | Loans, credit |

## Fallback

| Category | For |
|---|---|
| `other` | Uncategorised |
