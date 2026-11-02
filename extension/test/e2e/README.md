# End-to-end test

Loads the **real, shipped extension** in a headless Chromium (via Playwright) against a
**controlled fake service** and drives the actual code path:

in-session auth capture (content hook) → inventory (paginated fetch with replayed headers) →
the listing UI (Settings → Advanced tools) → send to the download sink.

Only the *service* is faked — a user's real authenticated session can't be reproduced in CI, and
that is the whole product. Everything else is the code as shipped.

## Run

```
npm run e2e            # e2e.test + author-flow + author-flow-complex + mixed-auth + marketplace-live
npm run e2e:fakebank   # the fake bank through the external-hooks bridge
```

Requirements: `playwright` (devDependency) + its Chromium (`npx playwright install chromium`), and
a display — on a headless box use `xvfb` (the scripts wrap with `xvfb-run`). Loading an MV3
extension needs a real browser context (headed under a virtual display), not pure headless.

CI runs every suite on each push and pull request (the `e2e` job in `.github/workflows/build.yml`), one
step per suite. `marketplace-live` reads the LIVE catalog, so a failure there can be the network.

## What it does

1. Starts a fake logged-in service on loopback http (the validator allows http for localhost):
   `mock-service.mjs` (receipts SPA + PDFs), `mock-complex.mjs` (several lists + a Referer-gated PDF),
   `mock-mixed.mjs` (cookie-authed list, bearer-authed PDF).
2. Copies `extension/` to a temp dir and adds `http://localhost/*` to its host permissions — the grant a
   user gives when enabling a source. The shipped manifest is never touched.
3. `setup.mjs` then does what the UI would after the user clicked through: enables the source, registers
   its capture scripts at runtime (`lib/capture.js`; the page hook runs in the MAIN world, so it is not
   injected from the manifest) and gives the consent a community source needs — or arms record mode.
4. Opens the SPA (→ the hook captures the session or the samples) and drives the real pages: the recorder
   (`author.html`) and the listing/sending UI (`advanced.html`).

The unit suite (`npm test`) stays browser-free and fast; the e2e suites are separate.

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
- **Statements** (`/api/accounts/{id}/statement?from&to`): a PDF per account and completed month.
- **Portfolio** (`/api/broker/timeline`): buys, a sell, a dividend with tax withheld, interest, a fee, and
  cash in and out of the broker account.
- **Control API**, so a test can simulate new activity: `POST /__control/movement`, `POST /__control/trade`,
  `POST /__control/reset`, `GET /__control/state`. No session needed.

The API speaks its own field names, like any bank; `fakeBankSource()` maps them the way a published source
does (three outputs: `movements`, transaction@1, grouped by account; `statements`, invoice@1 with a PDF;
`portfolio`, investment@2). Everything is
fictional and in English. The source is never shipped in the extension nor published to the registry.
