// Redaction correlates TOKENS the same way it correlates ids: the same token value → the same [jwt#N] tag,
// across a sent Authorization header AND client storage — so the team can see, from the redacted bundle
// alone, whether the API bearer is the same token as e.g. localStorage.auth_token.access_token (the exact
// question that cost several Raisin rounds), WITHOUT ever seeing a value. All tokens SYNTHETIC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoff } from '../src/lib/redact.js';

// JWT shape built at RUNTIME (no literal token in the source, so the no-PII guard doesn't flag it).
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sig) => b64({ alg: 'HS256' }) + '.' + b64({ sub: '1' }) + '.' + sig;
const API = jwt('APISIG');       // the bearer the SPA sends to the API
const ACCESS = jwt('ACCESSSIG'); // Keycloak access token in storage
const REFRESH = jwt('REFRESHSG');

test('same token in a sent header AND storage → the SAME [jwt#N] tag; different tokens differ', () => {
  const b = buildHandoff({
    domain: 'x.test',
    samples: [{ url: 'https://api.x.test/tams/v1/accounts', method: 'GET', reqHeaders: { authorization: 'Bearer ' + API, accept: 'application/json' } }],
    storage: { local: { auth_token: JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH }) }, session: {} },
  });
  const hdr = b.samples[0].reqHeaders.authorization;         // "Bearer [jwt#N]" — scheme kept, no value
  const acc = b.storage.local.auth_token.access_token;       // "[jwt#M]"
  const ref = b.storage.local.auth_token.refresh_token;
  assert.match(hdr, /^Bearer \[jwt#\d+\]$/, 'the sent bearer keeps only its scheme + a correlated tag');
  assert.match(acc, /^\[jwt#\d+\]$/);
  // API bearer != Keycloak access token → DIFFERENT tags (this is exactly what Raisin needed to reveal)
  assert.notEqual(hdr.replace('Bearer ', ''), acc);
  assert.notEqual(acc, ref); // access vs refresh differ too
  // No raw token leaks anywhere in the serialized bundle
  assert.equal(JSON.stringify(b).includes('APISIG') || JSON.stringify(b).includes('ACCESSSIG'), false);
});

test('the identical token in header and storage shares one tag', () => {
  const b = buildHandoff({
    domain: 'x.test',
    samples: [{ url: 'https://api.x.test/a', method: 'GET', reqHeaders: { authorization: 'Bearer ' + ACCESS } }],
    storage: { local: { auth_token: JSON.stringify({ access_token: ACCESS }) }, session: {} },
  });
  const hdrTag = b.samples[0].reqHeaders.authorization.replace('Bearer ', '');
  assert.equal(hdrTag, b.storage.local.auth_token.access_token, 'same value → same tag → the bearer IS the stored access token');
});
