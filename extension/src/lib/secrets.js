import { chrome } from './ext.js';
// Secrets store — SEPARATE from config, referenced by `secret://<name>`.
// Holds sink credentials (OAuth tokens, pairing tokens). NEVER referenced from an
// adapter or included in exportable config.
// TODO(security): encrypt at rest; storage.local is plaintext on disk.
const KEY = 'habeas:secrets';

export async function setSecret(name, value) {
  const o = await chrome.storage.local.get(KEY);
  const s = o[KEY] || {};
  s[name] = value;
  await chrome.storage.local.set({ [KEY]: s });
}
export async function getSecret(ref) {
  if (!ref) return null;
  const name = String(ref).replace(/^secret:\/\//, '');
  const o = await chrome.storage.local.get(KEY);
  return (o[KEY] || {})[name] || null;
}
