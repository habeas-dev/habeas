# core/

The Habeas **Core** — the only code that is reviewed and shipped. It is
deliberately small: all service-specific behavior lives in declarative adapters,
never here.

## Responsibilities

- **Adapter loading & validation** — load adapters, validate against
  `../adapters/schema/adapter.schema.json`, check version compatibility.
- **Session detection** — determine whether the user is logged into an adapter's
  host, using the adapter's declared `loginSignal`.
- **Capture SDK** — the primitives adapters are allowed to use:
  - authenticated `fetch` (`credentials: 'include'`, same-origin to the host —
    cookies and `cf_clearance` ride along automatically),
  - authenticated blob/PDF download,
  - DOM reads (fallback for services with no JSON endpoint),
  - pagination (cursor / offset / "load more").
- **Normalization** — map adapter output into a versioned schema from `../schemas/`.
- **Dedupe** — skip already-extracted records by the adapter's `dedupeKey`.
- **Sinks** — export normalized records to a local file (JSON + ZIP of PDFs) or
  POST to a user-configured endpoint with a per-user pairing token.
- **Consent & capability enforcement** — show what an adapter will read and where
  it will send, require explicit approval, and confine the adapter to its
  declared `capabilities`.

## Not here

- No per-service logic (that's an adapter).
- No credential storage.
- No `eval` / no remotely-hosted code (MV3 + security).

Status: **not yet implemented.** See `../docs/FUNCTIONAL-SPEC.md` §6.
