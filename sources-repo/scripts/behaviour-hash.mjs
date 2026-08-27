import { createHash } from 'node:crypto';

// A version identifies one BEHAVIOUR, permanently — not one byte string. Prose is allowed to change
// under the same version, because prose is served from this index rather than from the copy a user has
// installed: the website and the marketplace both read it here, so a corrected note reaches everybody
// without offering anyone an update whose only difference is wording.
//
// What makes that safe rather than a promise is this hash. It covers everything EXCEPT the presentational
// fields, so republishing under the same version can be checked instead of trusted: same version with a
// different hash means the behaviour moved without the version moving, and the marketplace would never
// offer the fix to anyone already on it.
const PRESENTATION = new Set(['changelog', 'content', 'brand', 'credit', 'contributors']);

/** Stable stringify: key order must not change the hash, or an editor reordering fields breaks it. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

export function behaviourHash(adapter) {
  const bare = {};
  for (const k of Object.keys(adapter)) if (!PRESENTATION.has(k)) bare[k] = adapter[k];
  return createHash('sha256').update(canonical(bare)).digest('hex').slice(0, 16);
}
