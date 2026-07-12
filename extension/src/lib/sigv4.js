// AWS Signature Version 4 (single-chunk, header auth) — enough to PUT/GET objects on S3 and S3-compatible
// stores (MinIO, Cloudflare R2, Backblaze B2 S3). Pure: uses only Web Crypto (crypto.subtle), so it runs
// in the service worker and is unit-testable in node. Validated against AWS's documented GET-object example.
const enc = new TextEncoder();
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
// RFC 3986 encoding AWS expects (encodeURIComponent, plus the extra chars it leaves alone).
const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export async function sha256Hex(data) {
  const buf = typeof data === 'string' ? enc.encode(data) : (data instanceof Uint8Array ? data : new Uint8Array(data));
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
}
async function hmac(keyBytes, msg) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

// Sign a request. `payloadHash` = hex SHA-256 of the body (pass 'UNSIGNED-PAYLOAD' to skip hashing a large
// blob). `amzDate` = YYYYMMDDTHHMMSSZ. Returns the headers to send (host, x-amz-date, x-amz-content-sha256,
// Authorization) merged with any extraHeaders. Caller sets the body separately.
export async function sigv4Sign({ method, url, region, service = 's3', accessKeyId, secretAccessKey, amzDate, payloadHash, extraHeaders = {} }) {
  const u = new URL(url);
  const date = amzDate.slice(0, 8);
  const lc = { host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  for (const [k, v] of Object.entries(extraHeaders)) lc[k.toLowerCase()] = String(v).trim();
  const names = Object.keys(lc).sort();
  const canonHeaders = names.map((n) => n + ':' + String(lc[n]).trim() + '\n').join('');
  const signedHeaders = names.join(';');
  const canonUri = u.pathname === '' ? '/' : u.pathname.split('/').map(uriEncode).join('/');
  const canonQuery = [...u.searchParams.entries()].map(([k, v]) => [uriEncode(k), uriEncode(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => k + '=' + v).join('&');
  const canonReq = [method, canonUri, canonQuery, canonHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const strToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonReq)].join('\n');
  let k = enc.encode('AWS4' + secretAccessKey);
  for (const part of [date, region, service, 'aws4_request']) k = await hmac(k, part);
  const signature = hex(await hmac(k, strToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { signature, authorization, headers: { host: lc.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, ...extraHeaders, Authorization: authorization } };
}
