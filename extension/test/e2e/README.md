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
