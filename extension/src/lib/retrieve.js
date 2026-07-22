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

// The relative paths a delivered doc could occupy. Mirrors delivery: service = adapter.service||id, ext
// variants (a source may emit pdf and/or html/json), and BOTH with- and without the account/group folder —
// a row loaded from the store may have lost/changed its group label vs the folder it was written under.
function candidatePaths(adapter, sink, record, preferExt) {
  const service = (adapter && adapter.service) || (adapter && adapter.id) || 'documents';
  const exts = [...new Set([preferExt, documentExt(adapter), 'pdf', 'xls', 'xlsx', 'html', 'json'].filter(Boolean))];
  const variants = [{ date: record.date, internalId: record.internalId, _group: record.group ? { name: record.group } : null }];
  if (record.group) variants.push({ date: record.date, internalId: record.internalId, _group: null }); // no-group fallback
  const out = [];
  for (const d of variants) for (const ext of exts) out.push({ ext, path: pathFor(sink, d, { service, ext }, ext) });
  return out;
}

// Try to pull the delivered file back. Returns { blob, ext } on success, or { tried:[paths] } on failure
// (so the viewer can show what it looked for — was the file absent, or the path not reconstructable?).
// preferExt: try that format's path first (a statement delivered as both PDF and Excel).
export async function retrieveDelivered(sink, adapter, record, preferExt, opts = {}) {
  if (!isRetrievable(sink)) return { tried: [] };
  let handle = null;
  if (sink.type === 'local-folder') {
    handle = await getHandle('dir:' + sink.id).catch(() => null);
    if (!handle || !(await verifyPermission(handle).catch(() => false))) return { tried: [], reason: 'folder not connected' };
  }
  const tried = [];
  // opts.only: try ONLY the preferExt paths (don't fall back to other formats). Used to fetch the JSON detail
  // for the drawer — a fallback would waste a PDF download and then fail to JSON.parse it.
  let cands = candidatePaths(adapter, sink, record, preferExt);
  if (opts.only && preferExt) cands = cands.filter((c) => c.ext === preferExt);
  for (const { ext, path } of cands) {
    try {
      let blob = null;
      if (sink.type === 'dropbox') blob = await dropboxRetrieve(sink, path);
      else if (sink.type === 'webdav') blob = await webdavRetrieve(sink, path);
      else if (sink.type === 's3') blob = await s3Retrieve(sink, path);
      else if (sink.type === 'local-folder') blob = await folderRetrieve(handle, path);
      if (blob) return { blob, ext, path };
      tried.push(path); // reached the backend, got a clean "not found"
    } catch (e) { tried.push(path + ' — ' + ((e && e.message) || String(e))); }
  }
  return { tried };
}
