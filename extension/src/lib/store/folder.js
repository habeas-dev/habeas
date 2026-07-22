// Canonical store — FOLDER backend (File System Access, Chromium). Hosts the store inside a `.habeas-store`
// subfolder of a directory the user picked. Point it at a cloud-synced folder (Drive/Dropbox desktop) and it
// becomes a shared multi-device store — concurrency is the sync service's (last-write-wins on the file). The
// directory handle is kept in IndexedDB (lib/fs.js), like the folder sink. Each source is month-SHARDED under
// `<sourceId>/<YYYY-MM>.json` (see sharded.js); a pre-shard `<sourceId>.json` is auto-reformatted on load.
import { getHandle, verifyPermission } from '../fs.js';
import { makeShardedStore, pathPrim } from './sharded.js';

const SUB = '.habeas-store';

export function make(cfg) {
  const key = 'store-dir:' + ((cfg && cfg.id) || 'canon'); // IndexedDB key for the chosen directory handle
  async function root() {
    const h = await getHandle(key);
    if (!h) throw new Error('no store folder chosen');
    if (!(await verifyPermission(h))) throw new Error('store folder permission denied');
    return h.getDirectoryHandle(SUB, { create: true });
  }
  const parts = (p) => String(p).split('/').filter(Boolean);
  async function walk(segs, create) { let d = await root(); for (const s of segs) d = await d.getDirectoryHandle(s, { create }); return d; }
  const io = {
    async readJson(path) {
      try { const p = parts(path); const file = p.pop(); const d = await walk(p, false); return JSON.parse(await (await d.getFileHandle(file)).getFile().then((f) => f.text())); }
      catch (e) { return null; } // missing dir/file → nothing there
    },
    async writeJson(path, obj) {
      const p = parts(path); const file = p.pop(); const d = await walk(p, true);
      const fh = await d.getFileHandle(file, { create: true }); const w = await fh.createWritable(); await w.write(JSON.stringify(obj)); await w.close();
    },
    async removePath(path) { try { const p = parts(path); const file = p.pop(); await (await walk(p, false)).removeEntry(file); } catch (e) { /* already gone */ } },
    async removeDir(path) { try { const p = parts(path); const name = p.pop(); await (await walk(p, false)).removeEntry(name, { recursive: true }); } catch (e) { /* already gone */ } },
    async listDir(path) {
      try { const d = await walk(parts(path), false); const out = []; for await (const [name, h] of d.entries()) out.push({ name, isDir: h.kind === 'directory' }); return out; }
      catch (e) { return []; }
    },
  };
  return makeShardedStore(pathPrim(io)); // root '' → the SUB dir is io's own root
}
