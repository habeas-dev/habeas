// Shared HTML escaper for interpolating untrusted (network/source/OS-derived) values
// into innerHTML template strings. Single source of truth so escaping cannot drift
// per UI module. Also escapes the single quote so single-quoted attribute contexts
// stay safe, not just the double-quoted ones this codebase currently uses.
const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => MAP[c]);
