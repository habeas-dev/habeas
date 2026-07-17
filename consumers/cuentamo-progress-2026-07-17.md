# Habeas → Cuéntamo — Informe de progreso (2026-07-17)

> Estado del **lado Habeas** del contrato de datos ([`cuentamo-data-contract.md`](cuentamo-data-contract.md)).
> Todo lo descrito está implementado y verificado con tests; se entrega en la extensión **v0.3.0.28**.
> Las fuentes financieras actualizadas requieren extensión **≥ 0.3.0.24** (`minVersion`).

## TL;DR

- **Banco: listo.** Los movimientos bancarios entregan ya la forma canónica completa del contrato: `account`
  **estructurado** `{iban, last4, groupId, currency}`, `balanceAfter` y `valueDate` (donde la fuente los expone),
  `amount` decimal con signo + `direction`, `date` = fecha contable, `counterparty` normalizado.
- **Bróker: nuevo schema `investment@2` en producción**, con discriminador `recordType: "trade" | "cash"` y todos
  los campos del contrato. **Trade Republic** ya lo emite.
- **Datos preexistentes: se convierten solos.** Una migración única al arrancar re-normaliza el histórico ya
  almacenado a la forma nueva, y el siguiente Sync reenvía los registros corregidos a los sinks re-escribibles.
- **Podéis empezar a construir la ingesta ya**: la forma canónica y `investment@2` son estables.

## A. Banco — `transaction@1` + canónico (`sink.normalize`)

Un consumidor que active `sink.normalize` recibe la forma uniforme; el `account` string pasa a ser un **objeto**:

```json
{
  "id": "…", "date": "2026-03-01", "amount": -12.50, "currency": "EUR",
  "direction": "debit", "description": "…", "counterparty": "…",
  "category": "…", "type": "…", "number": null, "source": "ing-es",
  "account": { "iban": "ES…", "last4": "1332", "groupId": "…", "currency": "EUR" },
  "valueDate": "2026-03-02",     // solo si la fuente lo captura
  "balanceAfter": 1234.56,       // solo si la fuente lo captura
  "extra": { … }                 // todos los campos raw de la fuente
}
```

- `date` **es** la fecha contable (mapeadla a vuestro `bookedDate`).
- `account.last4` es el número que el usuario reconoce (últimos 4 de la tarjeta/cuenta), no un id interno.
- `amount` siempre decimal-mayor con signo; `direction` = `debit`/`credit`.

**Cobertura por fuente:**

| Fuente | `account` | `valueDate` | `balanceAfter` |
|---|---|---|---|
| ING España | `{iban, last4, currency}` | — (no en el feed) | ✅ |
| Openbank | `{last4, groupId, currency}` | — (no en el feed) | ✅ |
| Revolut | `{groupId=divisa, currency}` | ✅ | ✅ (escala minor-unit) |
| WiZink | `{last4, groupId, currency}` | — | — (feed sin saldo) |
| Financiera ECI | `{last4, groupId, currency}` | — | — (feed sin saldo) |
| CaixaBank Consumer | n/a (solo extractos, `invoice@1`) | — | — |

## B. Bróker — `investment@2` (nuevo)

Cada registro es **una** operación, discriminada por `recordType`:

**`trade`** (compra/venta/dividendo/split/traspaso de un instrumento):
```json
{
  "internalId": "…", "recordType": "trade", "date": "…", "currency": "EUR",
  "side": "buy|sell|dividend|split|transfer_in|transfer_out",
  "instrument": { "isin": "…", "ticker": "…", "mic": "…", "name": "…", "assetClass": "…" },
  "units": 10, "price": 25.5,
  "grossAmount": 255, "commission": 1.2, "taxWithheld": 0, "netAmount": 256.2,
  "exchangeRate": 1, "settlementAccount": "…"
}
```

**`cash`** (interés/ingreso/retirada/comisión/impuesto en la cuenta de efectivo):
```json
{
  "internalId": "…", "recordType": "cash", "date": "…", "currency": "EUR",
  "kind": "interest|deposit|withdrawal|fee|tax|other",
  "amount": 4.20, "direction": "credit", "description": "…", "account": "…"
}
```

- Un `side`/`kind` no reconocido se conserva **verbatim** (nada se pierde).
- Campos opcionales se omiten cuando no existen (no van a `null`).

**Trade Republic** emite ya `investment@2`: `recordType` inferido por ISIN, `side`/`kind` mapeados desde el
`eventType`, `instrument{isin,name}`, `settlementAccount`, y **`units`/`price`/`commission`** parseados de la
tabla "Transaction" de `timelineDetailV2` (etiquetas estables porque pedimos `locale: "en"`; comisión "Free" →
0). Los registros ya guardados backfillean el desglose **offline** en la migración (sin re-sync).
_Pendiente menor:_ `grossAmount`/`taxWithheld` solo cuando la operación los expone.

## C. Conversión de datos ya existentes

- **Migración única** al arrancar: re-normaliza en el sitio los registros ya guardados a la forma actual
  (bancos ganan `balanceAfter`/`valueDate`; los registros de Trade Republic guardados como `transaction@1`
  se promueven a `investment@2`). Idempotente y sellada para correr una sola vez.
- **Sello por registro** `srcVersion`: cada registro guarda la versión del source con la que se procesó por
  última vez (metadato del store, no viaja en el record que os llega).
- **Reenvío a sinks**: tras convertir, se resetea el ledger de entrega solo de los sinks **read/write**
  (carpeta/Drive/Dropbox/WebDAV/S3) → el siguiente Sync reescribe el manifiesto con la forma nueva. Los sinks
  de una vía (descarga, HTTP push) no se tocan.

## D. Qué podéis hacer ya en Cuéntamo

1. Implementar **una** ingesta contra la forma canónica (bancos) + `investment@2` (bróker) — misma forma para
   todas las fuentes.
2. Idempotencia por `internalId` (Habeas ya deduplica, pero toleradlo por si hay reenvíos tras la migración).
3. Mapear `canonical.date → bookedDate`, `account.last4`/`account.iban` a vuestra identidad de cuenta,
   `direction` al signo.

## E. Pendiente conocido (no bloquea la ingesta)

- Trade Republic: `grossAmount`/`taxWithheld` solo cuando la operación los expone (ventas/dividendos).
- `valueDate`/`balanceAfter` no existen en algunos feeds (WiZink/FECI/CaixaBank) — es esperado, no un fallo.
- Más fuentes de bróker (`investment@2`) por grabación.

## Referencias

- Contrato + análisis de brecha por fuente: [`cuentamo-data-contract.md`](cuentamo-data-contract.md) (§F, §G).
- Forma canónica y `sink.normalize`: [`README.md`](README.md).
- Extensión: **v0.3.0.28** · fuentes financieras `minVersion` **0.3.0.24**.
