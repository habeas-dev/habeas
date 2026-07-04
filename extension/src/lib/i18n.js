import { chrome } from './ext.js';
// i18n helper. Static text: mark elements with data-i18n (textContent) or data-i18n-html
// (innerHTML). Dynamic text: t('key', [subs]). Uses chrome.i18n / _locales.
export function t(key, subs) { return chrome.i18n.getMessage(key, subs) || key; }

export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  try { document.documentElement.lang = chrome.i18n.getUILanguage(); } catch (e) {}
}
