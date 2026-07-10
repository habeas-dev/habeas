// Keeps an externally-proposed http sink's request headers (e.g. a pairing token) OUT of plaintext
// config. Such headers are the only sink credential that used to live inline in `habeas:config`
// (unlike the http bearer token, which already goes through the encrypted secrets store via
// `tokenRef`). Here they get the same treatment: stored encrypted, referenced by `headersRef`.
import { getSecret, setSecret } from './secrets.js';
import { getConfig, upsert } from './config.js';

const secretName = (sinkId) => 'ext-headers-' + sinkId;
export const headersRefFor = (sinkId) => 'secret://' + secretName(sinkId);

// Move a proposed sink's inline `headers` into the encrypted secrets store, returning a sink that
// references them by `headersRef` instead. Sinks without headers (or already ref'd) pass through.
export async function secureSinkHeaders(sink) {
  if (!sink || sink.headersRef || !sink.headers || !Object.keys(sink.headers).length) return sink;
  await setSecret(secretName(sink.id), JSON.stringify(sink.headers));
  const { headers, ...rest } = sink;
  return { ...rest, headersRef: headersRefFor(sink.id) };
}

// Effective caller-supplied headers for an http sink: the encrypted `headersRef` if present, else
// any legacy inline `headers` (installs created before at-rest encryption). Never throws.
export async function resolveSinkExtraHeaders(sink) {
  if (sink && sink.headersRef) {
    try { return JSON.parse((await getSecret(sink.headersRef)) || '{}') || {}; } catch { return {}; }
  }
  return (sink && sink.headers) || {};
}

// One-time migration for installs whose http sinks still carry plaintext `headers` in config.
export async function migrateSinkHeaders() {
  const cfg = await getConfig();
  for (const s of (cfg.sinks || [])) {
    if (s.type === 'http' && s.headers && !s.headersRef) await upsert('sinks', await secureSinkHeaders(s));
  }
}
