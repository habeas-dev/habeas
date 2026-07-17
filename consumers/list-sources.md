# `list-sources` — configured-source discovery for consumers

A web consumer (an HTTP-sink origin: Cuéntamo, Tiquetera, ...) can ask a user's Habeas extension **which
sources the user currently has enabled**, so it can offer the relevant ones instead of hardcoding source ids.

This is capability **D** of the [external hooks](external-hooks.md) protocol. Like every external hook it is
**origin-scoped and consent-gated**; unlike `collect`/`list-groups` it needs **no prior route (grant)** and
returns **no user data**, only public descriptive metadata about the sources.

## 1. Transport

Habeas injects a bridge on every `https` page. You talk to it with `window.postMessage` (same-origin replies).
Reuse the helper from [external-hooks.md](external-hooks.md):

```js
function habeas(api, payload) {
  return new Promise((resolve) => {
    const id = 'h' + Math.random().toString(36).slice(2);
    function onMsg(ev) {
      const d = ev.data;
      if (ev.source !== window || !d || d.__habeasExt !== 'res' || d.id !== id) return;
      window.removeEventListener('message', onMsg);
      resolve(d.response);
    }
    window.addEventListener('message', onMsg);
    window.postMessage({ __habeasExt: 'req', id, api, payload }, location.origin);
  });
}
```

**Feature detection.** On load the bridge posts `{ __habeasExt: 'ready', version: 1 }` to the page. If Habeas
is not installed, a request simply never receives a reply, so apply your own timeout.

## 2. Request

```js
const res = await habeas('list-sources');   // no payload required
```

The requesting origin is taken **authoritatively from the sender** by the extension, never from the message.

## 3. Response

Every reply has the shape `{ ok, status, ... }` and never throws across the boundary.

| `status`    | Meaning | What to do |
|-------------|---------|------------|
| `pending`   | First request from this origin (or consent not yet granted). Habeas has opened its consent screen. | Wait and call again. Re-prompts are deduped per origin, so repeated calls will not stack consent windows. |
| `ok`        | The origin is granted. `res.sources` holds the list. | Use it. |
| `error`     | Malformed call (e.g. no origin). `res.error` has a short reason. | Fix and retry. |

There is **no distinct `denied` status**: if the user dismisses the consent screen, further calls keep
returning `pending` (a fresh prompt is offered again after ~5 minutes). Treat "still `pending` after the user
has had time to respond" as "not granted" (see the polling helper in §6).

### `ok` payload

```jsonc
{
  "ok": true,
  "status": "ok",
  "sources": [
    {
      "source": "ing-es",        // adapter id — pass this to propose-workflow
      "name": "ING España",      // human-readable name
      "service": "ing",          // service slug
      "categories": ["banking"], // one or more of the category catalog
      "trust": "community"       // "first-party" (audited) | "community"
    }
    // ...one entry per enabled source
  ]
}
```

## 4. Data schema

| Field        | Type       | Notes |
|--------------|------------|-------|
| `source`     | `string`   | The adapter id. Stable; use it as the `source` in `propose-workflow`. |
| `name`       | `string`   | Display name. |
| `service`    | `string`   | Service slug (several sources can share a service). |
| `categories` | `string[]` | From the shared category catalog (e.g. `banking`, `card`, `grocery`, `retail`, `investment`). |
| `trust`      | `string`   | `first-party` (audited by the project) or `community`. |

The list is the **same set the user sees** in Habeas. It is not tailored, filtered, or ranked per origin.

## 5. What it will and will not disclose

Returns **public metadata only**. It never returns, and Habeas never exposes through this hook:

- accounts / groups (IBANs, card numbers, portfolios) — those need `list-groups` on a **granted** route,
- documents, records, or any of the user's data,
- the user's routes, sinks, destinations, or credentials.

Guarantees:

- **Consent-gated.** The first request opens Habeas's consent screen ("a website wants to see which sources
  you have enabled"). Approval is remembered as a lightweight `list-sources` grant (origin only, no route).
- **Origin-scoped.** The grant belongs to the requesting origin; another origin must ask for its own.
- **Revocable.** The user can revoke it anytime in **Settings → Site integrations**, where it shows as
  "*origin* can see your enabled sources".
- **`https` only.** The bridge runs on secure pages; there is no plaintext-`http` path.

## 6. Recommended integration

```js
// Returns the enabled-source list, or null if the user does not grant within the window.
async function listSources({ tries = 20, delayMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await habeas('list-sources');
    if (!res || res.ok === false) throw new Error((res && res.error) || 'habeas error');
    if (res.status === 'ok') return res.sources;
    await new Promise((r) => setTimeout(r, delayMs)); // status === 'pending' → consent screen is open
  }
  return null; // still pending after the window → treat as not granted
}

// e.g. offer only the banking sources the user already has:
const sources = await listSources();
const banks = (sources || []).filter((s) => s.categories.includes('banking'));
```

Trigger the first call from a **user gesture** (a button), so the consent window is expected rather than a
surprise popup.

## 7. Relationship to the rest of the protocol

`list-sources` is for **discovery**. To actually receive data you still go through the normal flow with the
`source` ids it returns:

1. `propose-workflow` with `{ source, sink: { type:'http', url: <your-own-origin>/ingest } }` → user consents to that route.
2. optionally `list-groups` to let the user pick an account.
3. `collect` to deliver new documents to your sink.

See [external-hooks.md](external-hooks.md) for A/B/C. `list-sources` does not create a route and does not move
any data by itself.
