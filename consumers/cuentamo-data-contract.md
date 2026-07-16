# Contrato de datos que Cuéntamo necesita de una fuente (banco / bróker)

> Documento para el proyecto **[Habeas](https://github.com/habeas-dev/habeas)**.
> Define **qué campos mínimos** debe entregar un adaptador de Habeas para que
> Cuéntamo pueda ingerir, sin pérdida de información, (A) los **movimientos de una
> cuenta bancaria** y (B) los **movimientos de una cuenta de bróker/inversión**.
>
> Complementa a [`integracion-habeas.md`](integracion-habeas.md) (el *cómo*: bridge,
> consentimiento, token, endpoint). Aquí sólo está el *qué* (la forma de los datos).
>
> Estos requisitos están **derivados del modelo real de Cuéntamo** ya en producción:
> el pipeline de importación `push` (`RawBankTransaction` → `Transaction`, dedup por
> `reference`, mapeo de cuenta por `externalReference`) y el importador de bróker
> (`InvestmentOperation` + *cash movements*, hoy DeGiro y Trade Republic).

---

## 0. Reglas globales (aplican a A y B)

Cada campo se marca con su nivel de exigencia:

- **MUST** — sin él, el registro **no es ingerible** (se rechaza o se pierde).
- **SHOULD** — mejora el emparejamiento, la categorización o la calidad; su ausencia degrada, no rompe.
- **MAY** — deseable; si no viene, no pasa nada.

Convenciones **obligatorias** para todos los valores:

1. **Un registro = un evento contable.** Nunca agregados (ni netos diarios, ni resúmenes). Un apunte bancario = un registro; una operación de bróker = un registro.
2. **`internalId` estable e idempotente.** Cada registro lleva un identificador **único y estable en el tiempo**: la misma operación debe producir **el mismo `internalId`** en cada `collect`. Es la clave de deduplicación en Cuéntamo (mapea a `Transaction.reference`). Re-sincronizar debe ser inofensivo.
   - Si la fuente **no** expone un id nativo estable, el adaptador debe **sintetizar un hash determinista** a partir de campos inmutables (p. ej. `cuenta + fechaContable + importe + descripción + nº de secuencia del día`) y mantenerlo estable entre ejecuciones. **No vale** un id aleatorio por descarga.
3. **Importes en UNIDADES MAYORES decimales** (euros, no céntimos), como cadena o número con **punto** decimal: `-45.80`, no `-4580`. Si la fuente da céntimos, el adaptador **debe** convertir antes de entregar. Cuéntamo **no puede adivinar** la unidad.
4. **El signo es autoritativo vía `direction`** (`debit`/`credit`) cuando exista; si se entrega `amount` ya con signo, debe ser coherente (`credit` = +, `debit` = −).
5. **Fechas en ISO 8601** `YYYY-MM-DD` (fecha) o `YYYY-MM-DDThh:mm:ssZ` (si hay hora). Nada de formatos locales ambiguos.
6. **Moneda en ISO 4217** de 3 letras (`EUR`, `USD`).
7. **UTF-8** en todo texto.
8. **`extra`** — objeto libre con los campos crudos de la fuente que el canónico deje fuera. Cuéntamo lo conserva (trazabilidad); no lo interpreta. Mejor pasar de más que perder.

---

## A. Cuenta bancaria — movimientos

Un registro por **apunte** de la cuenta (cargo o abono). Alineado con el *canonical
record* de Habeas (`sink.normalize: true`) y con lo que Cuéntamo ya acepta en `push`.

| Campo | Nivel | Tipo | Mapea a | Notas |
|---|---|---|---|---|
| `internalId` | **MUST** | string | `Transaction.reference` | Id estable/idempotente (regla global 2). |
| `bookedDate` | **MUST** | date | `Transaction.date` | Fecha contable del apunte. |
| `amount` | **MUST** | decimal | `Transaction.amount` | Unidades mayores (regla 3). Con signo, o sin signo + `direction`. |
| `direction` | **MUST\*** | `debit`\|`credit` | signo de `amount` | \*MUST si `amount` viene sin signo; fuente autoritativa del signo. |
| `currency` | **MUST** | ISO 4217 | (validación) | Debe casar con la divisa de la cuenta destino. |
| `description` | **MUST** | string | `Transaction.concept` | Concepto tal cual lo muestra el banco. |
| `account` | **MUST** | objeto | resolución de cuenta | Ver §A.1. Identifica **a qué cuenta** pertenece el apunte. |
| `valueDate` | SHOULD | date | (nota / conciliación) | Fecha valor, si difiere de la contable. |
| `balanceAfter` | SHOULD | decimal | anclas de conciliación | Saldo tras el apunte: permite validar el cuadre y sugerir anclas. |
| `counterparty` | SHOULD | objeto | tercero (CIF) | `{ name, iban?, taxId? }`. Alimenta terceros/CIF y categorización. |
| `category` | SHOULD | string | pista de categoría | Categoría del banco; Cuéntamo la usa como sugerencia. |
| `type` / `subtype` | MAY | string | pista | `transfer` / `card` / `direct_debit` / `fee`… Útil para reglas. |
| `endToEndId` | MAY | string | `extra` | Referencia SEPA end-to-end, si existe. |
| `extra` | MAY | objeto | crudo | Regla global 8. |

### A.1 Identificación de la cuenta (`account`)

Cuéntamo debe poder decir **a qué `Account` del libro** va cada apunte. Basta con
**uno** de estos, en orden de preferencia:

```
account: {
  iban?: "ES12 **** 3456",   // IBAN, aunque venga enmascarado
  last4?: "3456",            // últimos 4 dígitos (si el IBAN va enmascarado)
  groupId?: "…",             // id de grupo/cuenta estable de Habeas (list-groups)
  currency?: "EUR"
}
```

- **MUST**: al menos `iban` **o** `last4` **o** un `groupId` estable.
- Cuéntamo empareja por **últimos 4 dígitos** contra `Account.externalReference`; si no hay match, el usuario elige/crea la cuenta y se guarda el identificador para futuras sincronizaciones. El `groupId` debe ser **estable entre ejecuciones** (se usará como ancla de mapeo).

### A.2 Ejemplo (bancario)

```json
{
  "internalId": "ing-es:ES1234:2026-04-01:0007",
  "bookedDate": "2026-04-01",
  "valueDate":  "2026-04-01",
  "amount": "-45.80",
  "direction": "debit",
  "currency": "EUR",
  "description": "COMPRA MERCADONA 1234 VALENCIA",
  "account": { "iban": "ES12 **** 3456", "last4": "3456", "currency": "EUR" },
  "counterparty": { "name": "MERCADONA SA", "taxId": "A46103834" },
  "balanceAfter": "1204.55",
  "category": "Supermercado",
  "extra": { "type": "CARD_PAYMENT", "cardLast4": "9012" }
}
```

---

## B. Cuenta de bróker — movimientos

Un export de bróker **mezcla dos cosas** que Cuéntamo modela por separado:

- **Operaciones sobre un instrumento** (`trade`) → `InvestmentOperation`.
- **Movimientos de efectivo** sin instrumento (`cash`) → una `Transaction` en la cuenta de efectivo del bróker (intereses, ingresos, retiradas, comisiones sueltas, impuestos).

Por eso **cada registro debe llevar un discriminador**:

```
recordType: "trade" | "cash"
```

### B.1 Registro `trade` (operación sobre instrumento)

| Campo | Nivel | Tipo | Mapea a | Notas |
|---|---|---|---|---|
| `internalId` | **MUST** | string | dedup | Id estable/idempotente (regla 2). |
| `recordType` | **MUST** | `"trade"` | — | Discriminador. |
| `date` | **MUST** | date(-time) | `InvestmentOperation.date` | Fecha de ejecución/contratación. Hora opcional. |
| `side` | **MUST** | enum | `InvestmentOperation.type` | `buy` \| `sell` \| `dividend` \| `split` \| `transfer_in` \| `transfer_out`. Ver §B.3. |
| `instrument` | **MUST** | objeto | catálogo `InvestmentInstrument` | Identidad del activo. Ver §B.4 (ISIN preferente). |
| `currency` | **MUST** | ISO 4217 | `InvestmentOperation.currency` | Divisa de la operación. |
| `units` | **MUST\*** | decimal(≤8 dp) | `InvestmentOperation.units` | \*MUST para `buy`/`sell`/`transfer_*`. Nº de títulos/participaciones. |
| `grossAmount` | **MUST\*** | decimal(2 dp) | `InvestmentOperation.grossAmount` | \*Importe bruto (antes de comisiones). MUST si no viene `price` (regla B.5). |
| `price` | SHOULD | decimal(≤6 dp) | `InvestmentOperation.price` | Precio por título en `currency`. |
| `commission` | SHOULD | decimal(2 dp) | `InvestmentOperation.commission` | Comisiones/costes de la operación. |
| `taxWithheld` | SHOULD | decimal(2 dp) | `InvestmentOperation.taxWithheld` | Retención (sobre todo en `dividend`). |
| `netAmount` | SHOULD | decimal(2 dp) | `InvestmentOperation.netAmount` | Efectivo realmente movido (= bruto ∓ comisiones ∓ retención). |
| `exchangeRate` | SHOULD | decimal(≤6 dp) | `InvestmentOperation.exchangeRate` | Si `currency` ≠ divisa de la cuenta de efectivo. |
| `assetClass` | SHOULD | enum | tipo de instrumento | `equity` \| `etf` \| `fund` \| `bond` \| `crypto` \| `other`. |
| `settlementAccount` | SHOULD | objeto | cuenta de efectivo | Igual forma que §A.1: a qué cuenta liquida (para cuadrar el saldo). |
| `notes` / `extra` | MAY | — | `notes` / crudo | — |

### B.2 Registro `cash` (efectivo sin instrumento)

| Campo | Nivel | Tipo | Mapea a | Notas |
|---|---|---|---|---|
| `internalId` | **MUST** | string | dedup | Id estable/idempotente. |
| `recordType` | **MUST** | `"cash"` | — | Discriminador. |
| `date` | **MUST** | date | `Transaction.date` | — |
| `amount` | **MUST** | decimal | `Transaction.amount` | Unidades mayores, con signo o + `direction`. |
| `currency` | **MUST** | ISO 4217 | — | — |
| `kind` | **MUST** | enum | categoría/tipo | `interest` \| `deposit` \| `withdrawal` \| `fee` \| `tax` \| `other`. |
| `description` | **MUST** | string | `Transaction.concept` | — |
| `account` | **MUST** | objeto | cuenta de efectivo | Forma de §A.1. |
| `direction` | MUST\* | `debit`\|`credit` | signo | \*si `amount` viene sin signo. |
| `counterparty` / `extra` | MAY | — | — | — |

### B.3 `side` — semántica esperada

- `buy` / `sell` — compra/venta. Requieren `units` y (`price` o `grossAmount`).
- `dividend` — reparto de dividendo/cupón del instrumento. `grossAmount` = bruto, `taxWithheld` = retención, `netAmount` = neto cobrado.
- `split` — desdoblamiento/contrasplit. Indicar en `units` **la variación de títulos** resultante (o el ratio en `extra` con convención explícita). Sin importe de efectivo.
- `transfer_in` / `transfer_out` — entrada/salida de títulos **sin compraventa** (traspaso de cartera entre brókers). `units` obligatorio; `price`/coste, si se conoce, en `extra`.
- Otras acciones corporativas (fusiones, canjes…) **fuera de alcance v1**.

### B.4 Identidad del instrumento (`instrument`) — precedencia

```
instrument: {
  isin?:   "IE00B4L5Y983",   // PREFERENTE
  ticker?: "IWDA",           // símbolo/ticker
  mic?:    "XAMS",           // mercado (MIC) — desambigua el ticker
  name?:   "iShares Core MSCI World UCITS ETF",
  assetClass?: "etf"
}
```

- **MUST**: al menos **un identificador de máquina** — `isin` **o** (`ticker` [+ `mic`]). Sólo `name` es un fallback débil (dos activos distintos pueden compartir nombre).
- Precedencia de resolución en Cuéntamo: **`isin` > `ticker`+`mic` > `name`**. El `isin` es el ancla ideal porque Cuéntamo lo cruza con su catálogo global y con OpenFIGI.
- Cripto: si no hay ISIN, el `ticker` (`BTC`, `ETH`) con `assetClass: "crypto"` es suficiente.

### B.5 Consistencia de importes (trade)

- Regla: `grossAmount ≈ units × price`. **Entrega al menos dos de los tres** (`units`, `price`, `grossAmount`); Cuéntamo puede derivar el tercero, pero **no** puede inventar dos.
- `netAmount` es el efectivo que realmente entra/sale de la cuenta de liquidación; si no viene, Cuéntamo lo estima como `grossAmount ∓ commission ∓ taxWithheld`.
- **Una posición = (instrumento, cuenta de bróker).** El mismo ISIN en dos brókers son dos posiciones distintas; por eso `settlementAccount` importa.

### B.6 Ejemplos (bróker)

**Compra:**
```json
{
  "internalId": "degiro:98765",
  "recordType": "trade",
  "date": "2026-03-12",
  "side": "buy",
  "instrument": { "isin": "IE00B4L5Y983", "ticker": "IWDA", "mic": "XAMS",
                  "name": "iShares Core MSCI World UCITS ETF", "assetClass": "etf" },
  "units": "5",
  "price": "92.34",
  "grossAmount": "461.70",
  "commission": "2.00",
  "netAmount": "-463.70",
  "currency": "EUR",
  "settlementAccount": { "iban": "NL00 **** 7788", "last4": "7788" }
}
```

**Dividendo con retención:**
```json
{
  "internalId": "degiro:98790",
  "recordType": "trade",
  "date": "2026-03-20",
  "side": "dividend",
  "instrument": { "isin": "US0378331005", "ticker": "AAPL", "name": "Apple Inc." },
  "grossAmount": "12.00",
  "taxWithheld": "1.80",
  "netAmount": "10.20",
  "currency": "USD",
  "exchangeRate": "0.92",
  "settlementAccount": { "last4": "7788" }
}
```

**Movimiento de efectivo (intereses):**
```json
{
  "internalId": "tr:cash:2026-03-31:INT",
  "recordType": "cash",
  "date": "2026-03-31",
  "amount": "3.14",
  "direction": "credit",
  "currency": "EUR",
  "kind": "interest",
  "description": "Interés cuenta remunerada",
  "account": { "iban": "DE00 **** 4455", "last4": "4455" }
}
```

---

## C. Prioridad para el adaptador (si hay que ir por fases)

1. **Banco, MUST** (`internalId`, `bookedDate`, `amount`+`direction`, `currency`, `description`, `account`) → ya desbloquea la importación bancaria completa.
2. **Banco, SHOULD** (`counterparty`, `balanceAfter`, `category`) → terceros/CIF, conciliación y categorización.
3. **Bróker `trade` MUST** + **`cash` MUST** → desbloquea inversiones.
4. **Bróker SHOULD** (`commission`, `taxWithheld`, `exchangeRate`, `assetClass`) → fiscalidad de inversiones (plusvalías, retención, FX).

---

## D. Preguntas abiertas para el lado Habeas

1. **Unidades de `amount` en el canónico**: ¿mayores (decimal) o menores (céntimos)? Cuéntamo **requiere decimal mayor**; confirmar contra un payload real (`ing-es`) o normalizar en el adaptador.
2. **`internalId`**: ¿lo expone la fuente de forma estable, o hay que sintetizarlo? Necesitamos garantía de **estabilidad entre ejecuciones**.
3. **Enmascarado del IBAN**: ¿los últimos 4 dígitos son siempre visibles y estables? Es nuestra clave de mapeo de cuenta.
4. **Bróker**: ¿Habeas contempla un `source` de bróker (además de banca) y un canónico con `recordType` trade/cash, o hay que definirlo? Si aún no existe, este documento es la **propuesta de contrato**.
5. **Divisa de la operación vs. de la cuenta**: para `trade` en divisa extranjera, ¿la fuente da `exchangeRate`, o Cuéntamo lo resuelve con su FX histórico por fecha? (Cuéntamo sabe hacerlo, pero el dato de la fuente es más fiel.)

---

## E. Respuestas del lado Habeas + análisis de brecha (2026-07-16)

Contrastado con el modelo canónico actual (`lib/normalize.js#canonicalize`) y los schemas de
registro (`sinks/format.js#buildRecord`: `transaction@1`, `investment@1`).

**Estado del canónico Habeas hoy** (`canonicalize(record)`):
`{ id, date, amount, currency, direction, description, counterparty, category, type, account, number,
source, extra }`.

### Respuestas a §D

1. **Unidades de `amount` → DECIMAL MAYOR ✅.** `format.js#money()` parsea el importe a `Number` en unidades
   mayores (`"$9.00"→9`, `"2,28€"→2.28`); `minorUnits:true` (`inventory.js#minorExp`, ISO 4217) escala
   céntimos→mayor por-divisa antes de entregar. El canónico ya cumple la regla 3. **No hace falta que
   Cuéntamo adivine.**
2. **`internalId` → estable si la fuente lo expone; si no, se sintetiza en el adaptador.** El adaptador mapea
   `fields.internalId` a un campo nativo estable (p. ej. FECI usa `invoiceNumber`). Cuando no hay id nativo,
   hoy se compone declarativamente (`internalId: "{group.id}-{date}-{seq}"`). **Gap:** no hay un helper de
   *hash determinista* central que garantice unicidad/estabilidad — es responsabilidad del autor del
   adaptador. Propuesta: añadir un `fields.internalId.hashOf: [campos]` que sintetice un hash estable.
3. **Enmascarado del IBAN / last4 → disponible vía el grupo.** `api.groups.fields` mapea `iban`/`mask`
   (p. ej. FECI: `mask: masked_pan`) y expone `{group.iban}`/`{group.mask}`/`{group.id}` a las plantillas.
   El `groupId` (`group.id`) es **estable entre ejecuciones** (es la clave de la cuenta). **Gap:** el
   canónico `account` es hoy un **string** (`record.account || record.group`), no el **objeto**
   `{iban, last4, groupId, currency}` que pide §A.1 → hay que enriquecer `canonicalize` para emitir el
   objeto (derivando `last4` del `mask`/`iban`).
4. **Bróker → parcial.** Existe `investment@1` (`{internalId, date, instrument, isin, units, price, amount,
   currency, operation}`) y `transaction@1` lleva `isin` opcional (Trade Republic ya mezcla traspasos con
   ISIN). **Gap grande:** no hay discriminador `recordType: trade|cash`, ni `side` enum, ni
   `grossAmount/commission/taxWithheld/netAmount/exchangeRate/assetClass/settlementAccount`, ni
   `instrument` estructurado (`isin+ticker+mic`). **Este documento ES la propuesta de contrato** de bróker
   que Habeas debe implementar (schema `investment@2` + `cash`).
5. **`exchangeRate` → hoy no está en el canónico.** Si la fuente lo da, se conservaría en `extra`
   (`keepRaw`); para cumplir §B habría que promocionarlo a campo canónico. Cuéntamo puede resolver FX por
   fecha, pero el dato de la fuente es más fiel → **SHOULD** exponerlo cuando exista.

### Resumen de brecha

| Bloque | Cobertura Habeas hoy | Falta |
|---|---|---|
| **Banco MUST** | ~90% (`id,date,amount✓dec,direction,currency,description`) | `account` como **objeto** `{iban,last4,groupId}` (hoy string) |
| **Banco SHOULD** | `counterparty`, `category` ✓ | `bookedDate` vs `date` (renombrar/alias), `valueDate`, `balanceAfter` (→ promocionar de `extra`) |
| **Bróker `cash`** | `transaction@1` cubre casi todo | `kind` enum, `recordType:"cash"` |
| **Bróker `trade`** | `investment@1` básico | `recordType`, `side`, instrumento estructurado, `grossAmount/commission/taxWithheld/netAmount/exchangeRate/assetClass/settlementAccount` |

**Camino recomendado (lado Habeas):** (1) enriquecer `canonicalize` con `account{}` estructurado + alias
`bookedDate`/`valueDate`/`balanceAfter` (desbloquea Banco completo, la parte de mayor ROI); (2) definir el
canónico de bróker `trade/cash` de este contrato como schema nuevo; (3) autor de las fuentes de bróker
(Trade Republic ya tiene ISIN; DeGiro/otros por grabación).

### F. Estado de implementación (2026-07-16) — brecha del lado Habeas CERRADA

Pasos (1) y (2) del camino recomendado **implementados** (v0.3.0.22):

- **Banco.** `lib/normalize.js#canonicalize` ahora emite `account` como **objeto**
  `{iban?, last4?, groupId?, currency?}` (deriva `last4` de un IBAN o PAN enmascarado, `groupId` del grupo de
  la fuente; pasa un objeto ya estructurado tal cual; si no puede derivar nada mantiene el string histórico).
  `date` canónico **es** la fecha contable (`bookedDate` en §A). `valueDate` y `balanceAfter` se promocionan de
  `extra` a campos canónicos de primer nivel cuando la fuente los captura. En `sinks/format.js`, `transaction@1`
  añade `account`/`valueDate`/`balanceAfter` solo si la fuente los mapea (registros byte-idénticos si no).
- **Bróker.** Nuevo schema **`investment@2`** en `sinks/format.js#buildRecord`: discriminador
  `recordType:"trade"|"cash"` (inferido si falta), `side` enum (buy/sell/dividend/split/transfer_in/transfer_out),
  `instrument{isin,ticker,mic,name,assetClass}` estructurado, y `grossAmount/commission/taxWithheld/netAmount/
  exchangeRate/assetClass/settlementAccount` (trade) · `kind` enum (interest/deposit/withdrawal/fee/tax/other),
  `amount`, `description`, `account`, `direction` (cash). Un `side`/`kind` no reconocido se conserva verbatim.
  `investment@1` mantiene su forma plana histórica.

Cobertura de tests: `extension/test/investment2.test.mjs` (12 casos, datos 100% sintéticos). Pendiente
del lado Habeas: **paso (3)** — autor de fuentes de bróker reales (`investment@2`) por grabación.
