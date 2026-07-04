// Sharing a local source: export/import as portable JSON, and open a prefilled GitHub PR against
// the community source repo. No server is involved — contribution is a plain reviewed PR, which
// keeps community sources auditable and satisfies "no remote code".
import { validateAdapter } from '../adapters/validate.js';

const REPO = 'habeas-dev/sources';

export function sourceToJson(adapter) {
  return JSON.stringify(adapter, null, 2);
}

export function exportSource(adapter) {
  const blob = new Blob([sourceToJson(adapter)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = adapter.id + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

// GitHub "new file" flow → prefilled commit → PR. Contribution needs no backend.
export function buildShareUrl(adapter) {
  const filename = 'sources/' + adapter.id + '.json';
  const value = sourceToJson(adapter);
  return `https://github.com/${REPO}/new/main?filename=${encodeURIComponent(filename)}&value=${encodeURIComponent(value)}`;
}

export async function importFromFile(file) {
  const text = await file.text();
  let adapter;
  try { adapter = JSON.parse(text); } catch (e) { throw new Error('not valid JSON'); }
  const v = validateAdapter(adapter);
  if (!v.ok) throw new Error(v.errors.join('; '));
  return adapter;
}
