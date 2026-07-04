// Cross-browser WebExtension API. Firefox exposes promise-based `browser.*`; Chrome
// exposes promise-based `chrome.*` (MV3). Firefox's `chrome.*` is callback-only, so we
// prefer `browser` when present. Import this `chrome` instead of the global in every
// module that uses extension APIs, so the same code runs in Chrome and Firefox.
export const chrome = globalThis.browser ?? globalThis.chrome;
