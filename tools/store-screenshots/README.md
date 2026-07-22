# Store screenshots generator

Generates the 1280×800 PNGs used on the Chrome Web Store and Firefox AMO listings from a single
self-contained HTML mockup — so they can be regenerated (and edited/localized) whenever the UI or
copy changes, instead of hand-capturing the live extension.

## Files
- `screenshots.html` — five `<section class="shot">` panels (visual archive · popup launcher · cloud
  archive/first-run assistant · record mode · consent). Each shot shows when `document.body[data-shot="N"]`
  is set. Edit the headlines, sample data, or add a shot here; keep `SHOTS` in `render.mjs` in sync.
  All sample data is synthetic (fictional brands/banks/amounts) — safe to publish.
- `render.mjs` — renders each shot to `out/habeas-shot-N.png` at exactly 1280×800 (24-bit, no alpha),
  the size both stores accept.

## Run
```
npx playwright install chromium   # once, if not already present
node tools/store-screenshots/render.mjs
# → tools/store-screenshots/out/habeas-shot-1..5.png
```

## Notes
- These are faithful, on-brand mockups with representative (non-sensitive) data — cleaner than raw
  captures and safe to publish. If a store prefers real captures, replace them with live screenshots
  at the same 1280×800.
- Preview interactively: open `screenshots.html` in a browser and set `?` then run
  `document.body.dataset.shot = '3'` in the console (or add a small switcher).
- `out/` is build output — keep it out of git (see `.gitignore`).
