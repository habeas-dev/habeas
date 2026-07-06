// The canonical category catalog for UI use (marketplace, sink `accepts`, author mapper). The
// single source of truth lives in adapters/validate.js (so the registry's standalone validator
// enforces the same list); this re-exports it.
export { CATEGORIES } from '../adapters/validate.js';
