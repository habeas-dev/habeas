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

    // --- handoff collaboration workflow ---
    async addHandoff({ domain, bundle, submitter, handle, locale, client, now }) {
      const id = crypto.randomUUID();
      await DB.prepare('INSERT INTO handoffs (id, domain, bundle, submitter, handle, locale, client, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, domain, bundle, submitter, handle || '', locale || '', client, 'new', now, now).run();
      // source_json stays at its column default ('') until the team attaches an authored adapter.
      await DB.prepare('INSERT INTO writes (client, created_at) VALUES (?, ?)').bind(client, now).run();
      return id;
    },
    async listHandoffs(limit) {
      const r = await DB.prepare(`SELECT h.id, h.domain, h.handle, h.locale, h.status, h.source_id, h.created_at, h.updated_at, LENGTH(h.bundle) AS bytes,
          (SELECT COUNT(*) FROM handoff_messages m WHERE m.handoff_id = h.id) AS messages,
          (SELECT sender FROM handoff_messages m WHERE m.handoff_id = h.id ORDER BY m.created_at DESC LIMIT 1) AS last_from
        FROM handoffs h ORDER BY h.updated_at DESC LIMIT ?`).bind(limit).all();
      return (r.results || []).map((h) => ({ id: h.id, domain: h.domain, handle: h.handle || '', locale: h.locale || '', status: h.status, sourceId: h.source_id || null, at: new Date(h.created_at).toISOString(), updatedAt: new Date(h.updated_at).toISOString(), bytes: h.bytes, messages: h.messages, lastFrom: h.last_from || null, waitingForTeam: !['published', 'completed', 'declined', 'superseded'].includes(h.status) && (h.status === 'new' || h.last_from === 'submitter') }));
    },
    async getHandoffMeta(id) {
      return (await DB.prepare('SELECT id, domain, status, submitter, handle, locale, source_id, source_json FROM handoffs WHERE id = ?').bind(id).first()) || null;
    },
    async getHandoff(id) {
      const h = await DB.prepare('SELECT id, domain, handle, locale, submitter, status, source_id, bundle, created_at, updated_at FROM handoffs WHERE id = ?').bind(id).first();
      if (!h) return null;
      return { id: h.id, domain: h.domain, handle: h.handle || '', locale: h.locale || '', submitter: h.submitter, status: h.status, sourceId: h.source_id || null, at: new Date(h.created_at).toISOString(), updatedAt: new Date(h.updated_at).toISOString(), bundle: JSON.parse(h.bundle), messages: await this.getMessages(id), recordings: await this.listRecordings(id) };
    },
    // A targeted re-recording attached to an EXISTING handoff (stays in the same thread; never supersedes).
    async addRecording(handoffId, bundle, note, now) {
      await DB.prepare('INSERT INTO handoff_recordings (handoff_id, bundle, note, created_at) VALUES (?, ?, ?, ?)').bind(handoffId, bundle, note || '', now).run();
      return { at: new Date(now).toISOString() };
    },
    async listRecordings(handoffId) {
      const r = await DB.prepare('SELECT id, LENGTH(bundle) AS bytes, note, created_at FROM handoff_recordings WHERE handoff_id = ? ORDER BY created_at ASC').bind(handoffId).all();
      return (r.results || []).map((x) => ({ seq: x.id, at: new Date(x.created_at).toISOString(), bytes: x.bytes, note: x.note || '' }));
    },
    async getRecording(handoffId, seq) {
      const x = await DB.prepare('SELECT id, bundle, note, created_at FROM handoff_recordings WHERE handoff_id = ? AND id = ?').bind(handoffId, Number(seq)).first();
      return x ? { seq: x.id, at: new Date(x.created_at).toISOString(), note: x.note || '', bundle: JSON.parse(x.bundle) } : null;
    },
    async setHandoff(id, patch) {
      const sets = [], vals = [];
      if (patch.status != null) { sets.push('status = ?'); vals.push(patch.status); }
      if (patch.source_id != null) { sets.push('source_id = ?'); vals.push(patch.source_id); }
      if (patch.source_json != null) { sets.push('source_json = ?'); vals.push(patch.source_json); }
      if (patch.updated_at != null) { sets.push('updated_at = ?'); vals.push(patch.updated_at); }
      if (sets.length) { vals.push(id); await DB.prepare(`UPDATE handoffs SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run(); }
      const h = await this.getHandoffMeta(id);
      return h ? { id: h.id, domain: h.domain, status: h.status, sourceId: h.source_id || null } : null;
    },
    // sourceJson (optional) turns this into a VERSION message: it delivers an authored source version and
    // rides the same timeline as text, so the conversation shows each build in order (history preserved).
    async addMessage(id, from, text, client, now, sourceJson = '', captureRequest = '') {
      await DB.prepare('INSERT INTO handoff_messages (handoff_id, sender, text, source_json, capture_request, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, from, text, sourceJson || '', captureRequest || '', now).run();
      await DB.prepare('INSERT INTO writes (client, created_at) VALUES (?, ?)').bind(client, now).run();
      return { from, text, at: new Date(now).toISOString() };
    },
    async getMessages(id) {
      const r = await DB.prepare('SELECT sender, text, source_json, capture_request, created_at FROM handoff_messages WHERE handoff_id = ? ORDER BY created_at ASC').bind(id).all();
      return (r.results || []).map((m) => {
        const out = { from: m.sender, text: m.text, at: new Date(m.created_at).toISOString() };
        if (m.source_json) { try { out.source = JSON.parse(m.source_json); } catch (e) {} }
        if (m.capture_request) { try { out.captureRequest = JSON.parse(m.capture_request); } catch (e) {} }
        return out;
      });
    },
    async supersedePrior(submitter, domain, exceptId, now) {
      const r = await DB.prepare("UPDATE handoffs SET status = 'superseded', updated_at = ? WHERE submitter = ? AND domain = ? AND id != ? AND status IN ('new', 'in_review', 'needs_info')")
        .bind(now, submitter, domain, exceptId).run();
      return (r.meta && r.meta.changes) || 0;
    },
    async listSubmitterHandoffs(sid, limit) {
      const r = await DB.prepare(`SELECT h.id, h.domain, h.status, h.source_id, h.created_at, h.updated_at, (LENGTH(h.source_json) > 0) AS has_source,
          (SELECT COUNT(*) FROM handoff_messages m WHERE m.handoff_id = h.id) AS messages,
          (SELECT COUNT(*) FROM handoff_messages m WHERE m.handoff_id = h.id AND m.sender = 'team') AS team_messages,
          (SELECT sender FROM handoff_messages m WHERE m.handoff_id = h.id ORDER BY m.created_at DESC LIMIT 1) AS last_from,
          (SELECT created_at FROM handoff_messages m WHERE m.handoff_id = h.id ORDER BY m.created_at DESC LIMIT 1) AS last_at
        FROM handoffs h WHERE h.submitter = ? AND h.status != 'superseded' ORDER BY h.updated_at DESC LIMIT ?`).bind(sid, limit).all();
      return (r.results || []).map((h) => ({ id: h.id, domain: h.domain, status: h.status, sourceId: h.source_id || null, hasSource: !!h.has_source, at: new Date(h.created_at).toISOString(), updatedAt: new Date(h.updated_at).toISOString(), messages: h.messages, teamMessages: h.team_messages, lastFrom: h.last_from || null, lastAt: h.last_at ? new Date(h.last_at).toISOString() : null }));
    },
  };
}
