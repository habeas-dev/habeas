// In-memory store — used by the unit tests (and handy for local runs). Same interface as the
// D1-backed store in store-d1.mjs.
const round1 = (v) => Math.round(v * 10) / 10;

export function memoryStore() {
  const ratings = [];   // { id, stars, client }
  const comments = [];   // { id, text, author, client, at, status }
  const writes = [];     // { client, at }

  return {
    async getRatings(id) {
      const r = ratings.filter((x) => x.id === id);
      const count = r.length;
      return { avg: count ? round1(r.reduce((s, x) => s + x.stars, 0) / count) : 0, count };
    },
    async getComments(id, limit) {
      return comments
        .filter((c) => c.id === id && c.status === 'visible')
        .sort((a, b) => b.at - a.at)
        .slice(0, limit)
        .map((c) => ({ author: c.author, text: c.text, at: new Date(c.at).toISOString() }));
    },
    async recentWriteCount(client, since) {
      return writes.filter((w) => w.client === client && w.at >= since).length;
    },
    async rate(id, stars, client, now) {
      const existing = ratings.find((x) => x.id === id && x.client === client);
      if (existing) existing.stars = stars; else ratings.push({ id, stars, client });
      writes.push({ client, at: now });
      return this.getRatings(id);
    },
    async addComment(id, text, author, client, now) {
      comments.push({ id, text, author, client, at: now, status: 'visible' });
      writes.push({ client, at: now });
      return { author, text, at: new Date(now).toISOString() };
    },
  };
}
