import { chrome } from './ext.js';
// Theme-aware toolbar icon. Chrome has no native light/dark action icon, so we switch it
// from a page context (which can read prefers-color-scheme). Called from the app tab and
// the options page, so the icon matches the OS theme whenever Habeas is used. The dark
// variant lightens the (dark-green) H so it reads on a dark toolbar.
// Root-absolute, NOT relative. Chrome resolves setIcon paths against the extension root; Firefox
// resolves them against the CALLING DOCUMENT — and every caller lives in src/ui/, so a relative
// 'icon-16.png' became 'src/ui/icon-16.png', which does not exist, and Firefox drew a blank toolbar
// icon. Most visible while a sync runs, because that is when the badge makes you look at it.
const LIGHT = { 16: '/icon-16.png', 48: '/icon-48.png', 128: '/icon-128.png' };
const DARK = { 16: '/icon-dark-16.png', 48: '/icon-dark-48.png', 128: '/icon-dark-128.png' };

export function applyThemeIcon() {
  try {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    chrome.action.setIcon({ path: dark ? DARK : LIGHT });
  } catch (e) {}
}
export function watchThemeIcon() {
  try {
    applyThemeIcon();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyThemeIcon);
  } catch (e) {}
}
