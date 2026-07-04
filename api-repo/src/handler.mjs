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

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...CORS } });
const err = (status, message) => json({ error: message }, status);

export async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['sources', ':id', 'ratings'|'comments']
  if (parts.length === 0) return json({ service: 'habeas-api', ok: true });

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
