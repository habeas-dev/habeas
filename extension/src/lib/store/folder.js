// Canonical store — FOLDER backend (File System Access, Chromium). Hosts the store as per-source JSON files
// inside a `.habeas-store` subfolder of a directory the user picked. Point it at a cloud-synced folder
// (Drive/Dropbox desktop) and it becomes a shared multi-device store — concurrency is the sync service's
// (last-write-wins on the file). The directory handle is kept in IndexedDB (lib/fs.js), like the folder sink.
import { getHandle, verifyPermission } from '../fs.js';

const SUB = '.habeas-store';

export function make(cfg) {
  const key = 'store-dir:' + ((cfg && cfg.id) || 'canon'); // IndexedDB key for the chosen directory handle
  async function dir() {
    const root = await getHandle(key);
    if (!root) throw new Error('no store folder chosen');
    if (!(await verifyPermission(root))) throw new Error('store folder permission denied');
    return root.getDirectoryHandle(SUB, { create: true });
  }
  return {
    async loadSource(id) {
      try { const fh = await (await dir()).getFileHandle(id + '.json'); return JSON.parse(await (await fh.getFile()).text()); }
      catch (e) { return null; } // missing file → no data yet
    },
    async saveSource(id, data) {
      const fh = await (await dir()).getFileHandle(id + '.json', { create: true });
      const w = await fh.createWritable(); await w.write(JSON.stringify(data)); await w.close();
    },
    async listSources() {
      try { const out = []; for await (const [name] of (await dir()).entries()) if (name.endsWith('.json')) out.push(name.slice(0, -5)); return out; }
      catch (e) { return []; }
    },
  };
}
