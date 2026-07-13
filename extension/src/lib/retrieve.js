// Retrieve a previously-DELIVERED artifact back from the sink it was sent to, for the in-app document
// viewer. The canonical store only holds the normalized RECORD (JSON) — the actual file (PDF/Excel/HTML)
// lives in the sink. A sink is "retrievable" only if we can read an arbitrary file back from it; download
// (ephemeral ZIP) and http (POST-only) are NOT. We reconstruct the delivery path with the same pathFor the
// sink used at write time; if it can't be reconstructed/fetched, the caller falls back to the JSON viewer.
import { webdavRetrieve, s3Retrieve, folderRetrieve } from '../sinks/sinks.js';
import { dropboxRetrieve } from '../sinks/dropbox.js';
import { pathFor } from '../sinks/format.js';
import { documentExt } from '../runtime/inventory.js';
import { getHandle, verifyPermission } from './fs.js';

// Sink types we can read an individual file back from (→ eligible for a "delivered here, view it" badge).
export const RETRIEVABLE = new Set(['dropbox', 'webdav', 's3', 'local-folder']);
export const isRetrievable = (sink) => !!sink && RETRIEVABLE.has(sink.type);

// The relative paths a delivered doc could occupy (ext variants — a source may emit pdf and/or html/json).
// Mirrors delivery: service = adapter.service||id, group from the persisted record.group label.
function candidatePaths(adapter, sink, record) {
  const d = { date: record.date, internalId: record.internalId, _group: record.group ? { name: record.group } : null };
  const service = (adapter && adapter.service) || (adapter && adapter.id) || 'documents';
  const exts = [...new Set([documentExt(adapter), 'pdf', 'html', 'json'].filter(Boolean))];
  return exts.map((ext) => ({ ext, path: pathFor(sink, d, { service, ext }, ext) }));
}

// Try to pull the delivered file back. Returns { blob, ext } or null (not found / not reconstructable).
export async function retrieveDelivered(sink, adapter, record) {
  if (!isRetrievable(sink)) return null;
  let handle = null;
  if (sink.type === 'local-folder') {
    handle = await getHandle('dir:' + sink.id).catch(() => null);
    if (!handle || !(await verifyPermission(handle).catch(() => false))) return null;
  }
  for (const { ext, path } of candidatePaths(adapter, sink, record)) {
    try {
      let blob = null;
      if (sink.type === 'dropbox') blob = await dropboxRetrieve(sink, path);
      else if (sink.type === 'webdav') blob = await webdavRetrieve(sink, path);
      else if (sink.type === 's3') blob = await s3Retrieve(sink, path);
      else if (sink.type === 'local-folder') blob = await folderRetrieve(handle, path);
      if (blob) return { blob, ext };
    } catch (e) { /* try the next ext / fall through to null */ }
  }
  return null;
}
