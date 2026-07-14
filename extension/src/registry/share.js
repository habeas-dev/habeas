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

// Bump a source's `version` so the marketplace offers the change (versions compare lexicographically as
// dates `YYYY-MM-DD`, or `YYYY-MM-DD.N` for a same-day re-publish). Used when a contribution EDITS an
// existing source (e.g. adds a stream) — the PR overwrites `sources/<id>.json`, so the version must move.
export function bumpSourceVersion(adapter, today) {
  const t = today || new Date().toISOString().slice(0, 10);
  const cur = String((adapter && adapter.version) || '');
  const m = cur.match(/^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?$/);
  const next = (m && m[1] >= t) ? m[1] + '.' + ((+m[2] || 0) + 1) : t; // same-day/future → .N, else today
  return { ...adapter, version: next };
}

// GitHub "new file" flow → prefilled commit → PR. With an existing filename GitHub proposes it as a change
// (overwrite) → PR, so this works for both new sources and edits. Contribution needs no backend.
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
