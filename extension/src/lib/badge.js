import { chrome } from './ext.js';
// Toolbar action badge states, shared by auto (background) and manual (popup) runs.
async function set(text, bg, fg) {
  try {
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color: bg });
    if (text && fg && chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: fg });
  } catch (e) {}
}
export const badgeWorking = () => set('…', '#f1c40f', '#000'); // yellow — a sync is running
export const badgeCount = (n) => set(String(n), '#0a8a0a', '#fff'); // green — N new synced
export const badgeError = () => set('!', '#c0392b', '#fff'); // red — last run failed
export const badgeClear = () => set('', '#000');

// The toolbar icon's tooltip — shows what Habeas is doing (or its last result) on hover.
// Sets the action title (tooltip) AND mirrors the status into storage so an open popup can show live
// background progress (e.g. per-source "Listing…/Fetching…/Sending…" during a Sync-all sweep).
export const setStatus = (msg) => {
  try { chrome.action.setTitle({ title: msg ? 'Habeas — ' + msg : 'Habeas' }); } catch (e) {}
  try { chrome.storage.local.set({ 'habeas:status': { msg: msg || '', t: Date.now() } }); } catch (e) {}
};
