// Canonical store — FOLDER backend (File System Access, Chromium). Hosts the store inside a `.habeas-store`
// subfolder of a directory the user picked. Point it at a cloud-synced folder (Drive/Dropbox desktop) and it
// becomes a shared multi-device store — concurrency is the sync service's (last-write-wins on the file). The
// directory handle is kept in IndexedDB (lib/fs.js), like the folder sink. Each source is month-SHARDED under
// `<sourceId>/<YYYY-MM>.json` (see lib/store/sharded.js); a pre-shard `<sourceId>.json` is auto-reformatted.
import { getHandle, verifyPermission } from '../fs.js';
import { makeShardedStore } from './sharded.js';

const SUB = '.habeas-store';

export function make(cfg) {
  const key = 'store-dir:' + ((cfg && cfg.id) || 'canon'); // IndexedDB key for the chosen directory handle
  async function root() {
    const h = await getHandle(key);
    if (!h) throw new Error('no store folder chosen');
    if (!(await verifyPermission(h))) throw new Error('store folder permission denied');
    return h.getDirectoryHandle(SUB, { create: true });
  }
  // Walk `parts` (dir names) from the store root; create missing dirs only when create=true, else throw on miss.
  async function walk(parts, create) {
    let d = await root();
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return d;
  }
  const split = (rel) => rel.split('/').filter(Boolean);
  const prim = {
    async read(rel) {
      try {
        const parts = split(rel); const file = parts.pop();
        const d = await walk(parts, false);
        const fh = await d.getFileHandle(file);
        return JSON.parse(await (await fh.getFile()).text());
      } catch (e) { return null; } // missing dir/file → nothing there
    },
    async write(rel, obj) {
      const parts = split(rel); const file = parts.pop();
      const d = await walk(parts, true);
      const fh = await d.getFileHandle(file, { create: true });
      const w = await fh.createWritable(); await w.write(JSON.stringify(obj)); await w.close();
    },
    async remove(rel) {
      try { const parts = split(rel); const file = parts.pop(); const d = await walk(parts, false); await d.removeEntry(file); } catch (e) { /* already gone */ }
    },
    async removeDir(rel) {
      try { const parts = split(rel); const name = parts.pop(); const d = await walk(parts, false); await d.removeEntry(name, { recursive: true }); } catch (e) { /* already gone */ }
    },
    async listChildren(rel) {
      try {
        const d = await walk(split(rel), false); const out = [];
        for await (const [name, handle] of d.entries()) out.push({ name, isDir: handle.kind === 'directory' });
        return out;
      } catch (e) { return []; }
    },
  };
  return makeShardedStore(prim);
}
