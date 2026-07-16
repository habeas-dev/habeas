// Habeas social service — ratings & comments for community sources. Pure request handler:
// handleRequest(request, env) where env = { store, now(), clientId(request) }. This keeps it
// unit-testable in node with an in-memory store; the Cloudflare Worker (worker.mjs) wires a
// D1-backed store and a real client fingerprint.
//
// Contract (see the extension's docs/registry.md and src/registry/client.js):
//   GET  /sources/:id/ratings   -> { avg, count }
//   POST /sources/:id/ratings   { stars:1..5 }        -> { avg, count }
//   GET  /sources/:id/comments  -> [{ author, text, at }]
//   POST /sources/:id/comments  { text, author? }     -> { author, text, at }
// Anonymous + per-client rate limit + a moderation flag on comments.

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-max-age': '86400',
};
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_WRITES_PER_HOUR = 30;
const MAX_COMMENT = 1000;
const MAX_AUTHOR = 60;
const MAX_HANDOFF_BYTES = 2_000_000;   // a redacted recording is ~300KB; cap generously
const MAX_HANDOFFS_PER_HOUR = 20;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...CORS } });
const err = (status, message) => json({ error: message }, status);

export async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['sources', ':id', 'ratings'|'comments']
  if (parts.length === 0) return json({ service: 'habeas-api', ok: true });

  // Handoff collaboration workflow (redacted recordings a helper submits so a maintainer can author a
  // source): submit → review → two-way Q&A thread → status → attribution. See handleHandoff below.
  if (parts[0] === 'handoff') return handleHandoff(request, env, url, parts);
  if (parts[0] === 'submitter') return handleSubmitter(request, env, url, parts);

  if (parts[0] !== 'sources' || parts.length !== 3) return err(404, 'not found');
  const id = parts[1];
  const kind = parts[2];
  if (!ID_RE.test(id)) return err(400, 'invalid source id');
  if (kind !== 'ratings' && kind !== 'comments') return err(404, 'not found');

  const store = env.store;
  const now = env.now ? env.now() : Date.now();

  if (request.method === 'GET') {
    if (kind === 'ratings') return json(await store.getRatings(id));
    return json(await store.getComments(id, 100));
  }

  if (request.method === 'POST') {
    const client = env.clientId ? await env.clientId(request) : 'anon';
    const recent = await store.recentWriteCount(client, now - 3600_000);
    if (recent >= MAX_WRITES_PER_HOUR) return err(429, 'rate limit — try again later');

    let body;
    try { body = await request.json(); } catch (e) { return err(400, 'invalid JSON body'); }

    if (kind === 'ratings') {
      const stars = Number(body && body.stars);
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) return err(400, 'stars must be an integer 1..5');
      const res = await store.rate(id, stars, client, now);
      return json(res);
    }
    // comments
    const text = String((body && body.text) || '').trim();
    if (!text) return err(400, 'text required');
    if (text.length > MAX_COMMENT) return err(400, `text too long (max ${MAX_COMMENT})`);
    const author = String((body && body.author) || 'anon').trim().slice(0, MAX_AUTHOR) || 'anon';
    const created = await store.addComment(id, text, author, client, now);
    return json(created);
  }

  return err(405, 'method not allowed');
}

// ---- Handoff collaboration workflow ------------------------------------------------------------------
// A helper records a session, the extension redacts it (lib/redact.js) and submits it here so the Habeas
// team can author a source — with a two-way Q&A thread and attribution back to the helper. The submitter
// is a PSEUDONYMOUS id the extension generates (never PII); an optional `handle` is what gets credited.
// Team-side reads/writes are gated by an admin token (env.adminToken, a Worker secret).
const isAdmin = (request, url, env) => {
  const t = url.searchParams.get('token') || (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return !!(env.adminToken && t && t === env.adminToken);
};

async function handleHandoff(request, env, url, parts) {
  const store = env.store;
  const now = env.now ? env.now() : Date.now();
  const admin = isAdmin(request, url, env);

  // POST /handoff — submit a redacted recording.
  if (request.method === 'POST' && parts.length === 1) {
    const client = env.clientId ? await env.clientId(request) : 'anon';
    if (await store.recentWriteCount(client, now - 3600_000) >= MAX_HANDOFFS_PER_HOUR) return err(429, 'rate limit — try again later');
    let body; try { body = await request.json(); } catch (e) { return err(400, 'invalid JSON body'); }
    const bundle = body && body.bundle;
    if (!bundle || bundle.habeasHandoff !== 1) return err(400, 'not a Habeas handoff bundle');
    const serialized = JSON.stringify(bundle);
    if (serialized.length > MAX_HANDOFF_BYTES) return err(413, 'handoff too large');
    const submitter = String((body && body.submitter) || '').slice(0, 80);
    if (!submitter) return err(400, 'submitter id required');
    const handle = String((body && body.handle) || '').trim().slice(0, MAX_AUTHOR);
    const domain = String(bundle.domain || '').slice(0, 120);
    const id = await store.addHandoff({ domain, bundle: serialized, submitter, handle, client, now });
    // A newer submission for the same source (submitter + domain) supersedes the sender's earlier OPEN
    // ones — the team reviews only the most complete recording, and the contributor's inbox reflects it.
    const superseded = await store.supersedePrior(submitter, domain, id, now);
    return json({ ok: true, id, status: 'new', superseded });
  }

  // GET /handoff  — team list (admin only).
  if (request.method === 'GET' && parts.length === 1) {
    if (!admin) return err(401, 'unauthorized');
    return json(await store.listHandoffs(200));
  }

  if (parts.length >= 2) {
    const id = parts[1];
    const meta = await store.getHandoffMeta(id);

    // POST /handoff/:id/messages — a reply in the thread (team via admin token, or the submitter).
    if (parts.length === 3 && parts[2] === 'messages' && request.method === 'POST') {
      if (!meta) return err(404, 'not found');
      let body; try { body = await request.json(); } catch (e) { return err(400, 'invalid JSON body'); }
      const text = String((body && body.text) || '').trim();
      if (!text) return err(400, 'text required');
      if (text.length > MAX_COMMENT) return err(400, `text too long (max ${MAX_COMMENT})`);
      let from;
      if (admin) from = 'team';
      else if (body && body.submitter && body.submitter === meta.submitter) from = 'submitter';
      else return err(401, 'unauthorized');
      const client = env.clientId ? await env.clientId(request) : 'anon';
      if (await store.recentWriteCount(client, now - 3600_000) >= MAX_HANDOFFS_PER_HOUR) return err(429, 'rate limit — try again later');
      const msg = await store.addMessage(id, from, text, client, now);
      await store.setHandoff(id, { status: from === 'team' ? 'needs_info' : 'in_review', updated_at: now });
      return json(msg);
    }

    // GET /handoff/:id — full record + thread (team) OR status + thread scoped to the submitter.
    if (parts.length === 2 && request.method === 'GET') {
      if (!meta) return err(404, 'not found');
      if (admin) return json(await store.getHandoff(id));
      const submitter = url.searchParams.get('submitter');
      if (!submitter || submitter !== meta.submitter) return err(401, 'unauthorized');
      return json({ id: meta.id, domain: meta.domain, status: meta.status, sourceId: meta.source_id || null, handle: meta.handle || '', messages: await store.getMessages(id) });
    }

    // POST /handoff/:id — team updates status / links the created source (admin only).
    if (parts.length === 2 && request.method === 'POST') {
      if (!admin) return err(401, 'unauthorized');
      if (!meta) return err(404, 'not found');
      let body; try { body = await request.json(); } catch (e) { return err(400, 'invalid JSON body'); }
      const patch = { updated_at: now };
      if (body && body.status) patch.status = String(body.status).slice(0, 20);
      if (body && body.sourceId != null) patch.source_id = String(body.sourceId).slice(0, 80);
      return json(await store.setHandoff(id, patch));
    }
  }
  return err(404, 'not found');
}

// GET /submitter/:sid/handoffs — a helper lists their OWN submissions (status + unread team replies), so
// the extension can show an inbox and badge without any account — the pseudonymous submitter id is the key.
async function handleSubmitter(request, env, url, parts) {
  if (request.method === 'GET' && parts.length === 3 && parts[2] === 'handoffs') {
    const sid = parts[1];
    if (!sid) return err(400, 'submitter id required');
    return json(await env.store.listSubmitterHandoffs(sid, 100));
  }
  return err(404, 'not found');
}
