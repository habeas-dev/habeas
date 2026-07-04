// Cloudflare D1 (SQLite) store. Same interface as store-memory.mjs. Schema in schema.sql.
const round1 = (v) => Math.round(v * 10) / 10;

export function d1Store(DB) {
  return {
    async getRatings(id) {
      const r = await DB.prepare('SELECT AVG(stars) AS avg, COUNT(*) AS count FROM ratings WHERE source_id = ?').bind(id).first();
      const count = (r && r.count) || 0;
      return { avg: count ? round1(r.avg) : 0, count };
    },
    async getComments(id, limit) {
      const r = await DB.prepare("SELECT author, text, created_at FROM comments WHERE source_id = ? AND status = 'visible' ORDER BY created_at DESC LIMIT ?").bind(id, limit).all();
      return (r.results || []).map((c) => ({ author: c.author, text: c.text, at: new Date(c.created_at).toISOString() }));
    },
    async recentWriteCount(client, since) {
      const r = await DB.prepare('SELECT COUNT(*) AS n FROM writes WHERE client = ? AND created_at >= ?').bind(client, since).first();
      return (r && r.n) || 0;
    },
    async rate(id, stars, client, now) {
      await DB.prepare('INSERT INTO ratings (source_id, client, stars, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(source_id, client) DO UPDATE SET stars = excluded.stars, updated_at = excluded.updated_at')
        .bind(id, client, stars, now).run();
      await DB.prepare('INSERT INTO writes (client, created_at) VALUES (?, ?)').bind(client, now).run();
      return this.getRatings(id);
    },
    async addComment(id, text, author, client, now) {
      await DB.prepare('INSERT INTO comments (source_id, author, text, client, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, author, text, client, now).run();
      await DB.prepare('INSERT INTO writes (client, created_at) VALUES (?, ?)').bind(client, now).run();
      return { author, text, at: new Date(now).toISOString() };
    },
  };
}
