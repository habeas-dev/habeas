// Cloudflare Worker entry. Wires the D1-backed store + a privacy-preserving client fingerprint
// (a daily-salted hash of the caller IP — we never store the raw IP) into the pure handler.
import { handleRequest } from './src/handler.mjs';
import { d1Store } from './src/store-d1.mjs';

async function clientId(request) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'anon';
  const day = new Date().toISOString().slice(0, 10); // rotates the fingerprint daily
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + '|' + day));
  return [...new Uint8Array(buf)].slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  fetch: (request, env) => handleRequest(request, { store: d1Store(env.DB), now: () => Date.now(), clientId, adminToken: env.ADMIN_TOKEN }),
};
