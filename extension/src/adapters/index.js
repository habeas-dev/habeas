// Adapter catalog entrypoint. The real logic lives in loader.js (built-in + community sources,
// validated). This file re-exports it and keeps a synchronous `ADAPTERS` map of the built-ins
// for callers that don't need community sources.
export { getAdapters, getBuiltinAdapters, getStoredSources, saveSource, removeSource, BUILTIN, EXAMPLE_ADAPTERS } from './loader.js';
import { getBuiltinAdapters } from './loader.js';

export const ADAPTERS = getBuiltinAdapters();
