# adapters/

One adapter per service. Adapters are **declarative data (YAML), not code** — this
is required by Manifest V3 (no remotely-hosted code) and is the core of the
security model: a malicious adapter cannot execute arbitrary JS, only drive the
Core's bounded Capture SDK.

Each adapter is validated against [`schema/adapter.schema.json`](schema/adapter.schema.json).

## Fields

| Field | Purpose |
|---|---|
| `id` | Unique id, `<service>-<country>` (e.g. `carrefour-es`). |
| `version` | Adapter version (semver). |
| `name` | Human-readable name. |
| `hosts.read` | Hosts the adapter is allowed to read from. |
| `loginSignal` | How the Core detects an active session (cookie / DOM selector / a 200 from an endpoint). |
| `list` | How to enumerate records: request (or DOM), `itemsPath` (JSONPath), and `pagination`. |
| `detail` | How to fetch each record's detail / PDF. |
| `fields` | Map source fields → normalized fields, via JSONPath/CSS + optional bounded `transform`. |
| `dedupeKey` | Stable key used to skip already-extracted records. |
| `schema` | Target normalized schema (e.g. `receipt@1`). |
| `capabilities` | Least-privilege scope: `read` (hosts) and `write` (allowed sink). |

## Transforms (bounded — no arbitrary code)

Only a predefined set is allowed, e.g.:

- `date:<format>` — parse a date (e.g. `date:DD/MM/YYYY`).
- `money:<currency>` — parse an amount into minor units + currency.
- `regex:<pattern>` — extract a capture group.
- `trim`, `lower`, `upper`.

Need something not on the list? Open an issue to extend the format for everyone —
do **not** reach for inline JS.

## Financial adapters

Banking / card / investment / pension adapters are **first-party only** (see
`../CONTRIBUTING.md`).

## Example

See [`carrefour-es.yaml`](carrefour-es.yaml).
