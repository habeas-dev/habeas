// Compare dotted numeric versions ("0.1.27"). Returns -1 / 0 / 1. Non-numeric parts sort as 0.
import { chrome } from './ext.js';

export function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// The running extension version, from the manifest.
export function extensionVersion() {
  try { return chrome.runtime.getManifest().version; } catch (e) { return '0'; }
}

// Does the running extension satisfy a source's `minVersion` (min Habeas version it needs)? Absent → yes.
export function meetsMinVersion(minVersion) {
  return !minVersion || cmpVersion(extensionVersion(), minVersion) >= 0;
}
