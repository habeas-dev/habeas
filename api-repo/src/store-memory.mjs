// In-memory store — used by the unit tests (and handy for local runs). Same interface as the
// D1-backed store in store-d1.mjs.
const round1 = (v) => Math.round(v * 10) / 10;

export function memoryStore() {
  const ratings = [];   // { id, stars, client }
  const comments = [];   // { id, text, author, client, at, status }
  const writes = [];     // { client, at }
  const handoffs = [];   // { id, domain, bundle, submitter, handle, client, at, updated_at, status, source_id }
  const hmsgs = [];      // { handoff_id, from, text, at }
  let hseq = 0;

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

    // --- handoff collaboration workflow ---
    async addHandoff({ domain, bundle, submitter, handle, locale, client, now }) {
      const id = 'h' + (++hseq);
      handoffs.push({ id, domain, bundle, submitter, handle: handle || '', locale: locale || '', client, at: now, updated_at: now, status: 'new', source_id: null, source_json: '' });
      writes.push({ client, at: now });
      return id;
    },
    async listHandoffs(limit) {
      return handoffs.slice().sort((a, b) => b.updated_at - a.updated_at).slice(0, limit).map((h) => {
        const ms = hmsgs.filter((m) => m.handoff_id === h.id).sort((a, b) => a.at - b.at);
        const last = ms[ms.length - 1];
        // "waiting for the team" = a fresh submission, or the contributor sent the last message (awaiting reply).
        const waitingForTeam = h.status === 'new' || (last && last.from === 'submitter');
        return {
          id: h.id, domain: h.domain, handle: h.handle || '', locale: h.locale || '', status: h.status, sourceId: h.source_id || null,
          at: new Date(h.at).toISOString(), updatedAt: new Date(h.updated_at).toISOString(),
          bytes: h.bundle.length, messages: ms.length, lastFrom: last ? last.from : null, waitingForTeam,
        };
      });
    },
    async getHandoffMeta(id) {
      const h = handoffs.find((x) => x.id === id);
      return h ? { id: h.id, domain: h.domain, status: h.status, submitter: h.submitter, handle: h.handle, source_id: h.source_id, source_json: h.source_json || '' } : null;
    },
    async getHandoff(id) {
      const h = handoffs.find((x) => x.id === id);
      if (!h) return null;
      return {
        id: h.id, domain: h.domain, handle: h.handle || '', locale: h.locale || '', submitter: h.submitter, status: h.status, sourceId: h.source_id || null,
        at: new Date(h.at).toISOString(), updatedAt: new Date(h.updated_at).toISOString(),
        bundle: JSON.parse(h.bundle), messages: await this.getMessages(id),
      };
    },
    async setHandoff(id, patch) {
      const h = handoffs.find((x) => x.id === id);
      if (!h) return null;
      if (patch.status != null) h.status = patch.status;
      if (patch.source_id != null) h.source_id = patch.source_id;
      if (patch.source_json != null) h.source_json = patch.source_json;
      if (patch.updated_at != null) h.updated_at = patch.updated_at;
      return { id: h.id, domain: h.domain, status: h.status, sourceId: h.source_id || null };
    },
    // sourceJson (optional) turns this into a VERSION message: it delivers an authored source version and
    // rides the same timeline as text, so the conversation shows each build in order (history preserved).
    async addMessage(id, from, text, client, now, sourceJson = '') {
      hmsgs.push({ handoff_id: id, from, text, at: now, source_json: sourceJson || '' });
      writes.push({ client, at: now });
      return { from, text, at: new Date(now).toISOString() };
    },
    async getMessages(id) {
      return hmsgs.filter((m) => m.handoff_id === id).sort((a, b) => a.at - b.at).map((m) => {
        const out = { from: m.from, text: m.text, at: new Date(m.at).toISOString() };
        if (m.source_json) { try { out.source = JSON.parse(m.source_json); } catch (e) {} }
        return out;
      });
    },
    async supersedePrior(submitter, domain, exceptId, now) {
      const OPEN = new Set(['new', 'in_review', 'needs_info']);
      let n = 0;
      for (const h of handoffs) if (h.submitter === submitter && h.domain === domain && h.id !== exceptId && OPEN.has(h.status)) { h.status = 'superseded'; h.updated_at = now; n++; }
      return n;
    },
    async listSubmitterHandoffs(sid, limit) {
      return handoffs.filter((h) => h.submitter === sid).sort((a, b) => b.updated_at - a.updated_at).slice(0, limit).map((h) => {
        const ms = hmsgs.filter((m) => m.handoff_id === h.id).sort((a, b) => a.at - b.at);
        const last = ms[ms.length - 1];
        return {
          id: h.id, domain: h.domain, status: h.status, sourceId: h.source_id || null,
          at: new Date(h.at).toISOString(), updatedAt: new Date(h.updated_at).toISOString(),
          messages: ms.length, teamMessages: ms.filter((m) => m.from === 'team').length, hasSource: !!h.source_json,
          lastFrom: last ? last.from : null, lastAt: last ? new Date(last.at).toISOString() : null,
        };
      });
    },
  };
}
