# End-to-end test

Loads the **real, shipped extension** in a headless Chromium (via Playwright) against a
**controlled fake service** and drives the actual code path:

in-session auth capture (content hook) → inventory (paginated fetch with replayed headers) →
popup render → send to the download sink.

Only the *service* is faked — a user's real authenticated session can't be reproduced in CI, and
that is the whole product. Everything else is the code as shipped.

## Run

```
npm run e2e          # = xvfb-run -a node extension/test/e2e/e2e.test.mjs
```

Requirements: `playwright` (devDependency) + its Chromium (`npx playwright install chromium`), and
a display — on a headless box use `xvfb` (the script wraps with `xvfb-run`). Loading an MV3
extension needs a real browser context (headed under a virtual display), not pure headless.

## What it does

1. Starts `mock-service.mjs`: a fake logged-in SPA that sends a JWT to its own API, a paginated
   receipts endpoint, and a PDF endpoint (loopback http — the validator allows http for localhost).
2. Copies `extension/` to a temp dir and patches the manifest to grant the mock origin
   (host permission + content script + web-accessible hook).
3. Launches Chromium with the extension, seeds a datasource + the mock source + a download sink,
   opens the SPA (→ hook captures the session), then drives the popup to list and send.

The unit suite (`npm test`) stays browser-free and fast; this e2e is separate and on-demand.

## Fake bank for apps that consume Habeas

`mock-bank.mjs` is a fake bank and broker on loopback, and `harness.mjs` puts a browser in the state a user is
in after installing Habeas and logging into their bank: the real extension loaded, the fake bank's source
installed and enabled, its session captured. An app's own end-to-end suite builds on it and drives the bridge
for real (propose-workflow, consent, status, collect).

```
npm run e2e:fakebank     # = xvfb-run -a node extension/test/e2e/fakebank.e2e.mjs
```

That smoke test is itself a minimal app: it proposes a workflow to its own http endpoint, approves the consent
screen, collects, and checks that every movement and broker record arrives.

From another project:

```js
import { launchHabeasWithFakeBank } from '<habeas>/extension/test/e2e/harness.mjs';
const h = await launchHabeasWithFakeBank();   // { context, extensionId, bank, source, approveConsent, close }
const page = await h.context.newPage();       // the app, in the same browser as the extension
// … the app proposes its workflow, then:
await h.approveConsent();
```

What the bank serves:

- **Accounts** (`/api/accounts`): a current and a savings account with valid IBANs, and a card (`**** 4242`).
- **Movements** (`/api/accounts/{id}/movements?page=N`): newest first, 10 per page, each with a value date and
  the running balance. The current account needs three pages.
- **Portfolio** (`/api/broker/timeline`): buys, a sell, a dividend with tax withheld, interest, a fee, and
  cash in and out of the broker account.
- **Control API**, so a test can simulate new activity: `POST /__control/movement`, `POST /__control/trade`,
  `POST /__control/reset`, `GET /__control/state`. No session needed.

The API speaks its own field names, like any bank; `fakeBankSource()` maps them the way a published source
does (two outputs: `movements`, transaction@1, grouped by account; `portfolio`, investment@2). Everything is
fictional and in English. The source is never shipped in the extension nor published to the registry.
