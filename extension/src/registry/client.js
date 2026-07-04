// Registry client — browse/install community sources and read/post ratings & comments.
//
// Split of responsibilities (hybrid model):
//   * Source JSON + catalog index live in the GitHub repo habeas-dev/sources, published as a
//     static index.json (auditable, PR-reviewed, no server needed to INSTALL).
//   * Ratings & comments are the only mutable/social data → a thin habeas.dev service. The client
//     degrades gracefully when that service is absent (install still works; social data hidden).
import { validateAdapter } from '../adapters/validate.js';
import { saveSource } from '../adapters/loader.js';

const INDEX_URL = 'https://habeas-dev.github.io/sources/index.json';
const API_BASE = 'https://api.habeas.dev';

// index.json entry shape (see docs/registry.md):
// { id, name, service, categories[], trust, domain, crossDomain[], version, url, updated }
export async function fetchIndex() {
  const res = await fetch(INDEX_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error('registry ' + res.status);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.sources || []);
}

// Download the source JSON referenced by an index entry, validate it, and store it locally.
export async function installFromEntry(entry) {
  const res = await fetch(entry.url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('download ' + res.status);
  const adapter = await res.json();
  const v = validateAdapter(adapter);
  if (!v.ok) throw new Error(v.errors.join('; '));
  return saveSource(adapter);
}

// ---- Social layer (optional service). All calls fail soft. ----

export async function getRatings(id) {
  try {
    const r = await fetch(`${API_BASE}/sources/${encodeURIComponent(id)}/ratings`);
    if (!r.ok) return null;
    return await r.json(); // { avg, count }
  } catch (e) { return null; }
}

export async function postRating(id, stars, token) {
  const r = await fetch(`${API_BASE}/sources/${encodeURIComponent(id)}/ratings`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ stars }),
  });
  if (!r.ok) throw new Error('rating ' + r.status);
  return await r.json();
}

export async function getComments(id) {
  try {
    const r = await fetch(`${API_BASE}/sources/${encodeURIComponent(id)}/comments`);
    if (!r.ok) return [];
    return await r.json(); // [{ author, text, at }]
  } catch (e) { return []; }
}

export async function postComment(id, text, token) {
  const r = await fetch(`${API_BASE}/sources/${encodeURIComponent(id)}/comments`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error('comment ' + r.status);
  return await r.json();
}
