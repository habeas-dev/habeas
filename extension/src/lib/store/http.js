// Canonical store — HTTP backend. Hosts the store on a generic endpoint the user runs: per-source JSON at
// GET/PUT `<base>/<sourceId>.json`, plus a listing at GET `<base>/index.json` → { sources: [...] }. Works
// in any browser (no File System Access), and a real server can arbitrate concurrent writes cleanly.
export function make(cfg) {
  const base = String((cfg && cfg.url) || '').replace(/\/+$/, '');
  const auth = cfg && cfg.token ? { Authorization: 'Bearer ' + cfg.token } : {};
  const url = (id) => `${base}/${encodeURIComponent(id)}.json`;
  return {
    async loadSource(id) {
      const r = await fetch(url(id), { headers: auth });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('store http ' + r.status);
      return r.json();
    },
    async saveSource(id, data) {
      const r = await fetch(url(id), { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(data) });
      if (!r.ok) throw new Error('store http ' + r.status);
    },
    async listSources() {
      const r = await fetch(`${base}/index.json`, { headers: auth });
      if (!r.ok) return [];
      const j = await r.json().catch(() => ({}));
      return Array.isArray(j) ? j : (j.sources || []);
    },
  };
}
