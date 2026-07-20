#!/usr/bin/env node
// Capture replay — run an authored adapter's runtime against a handoff's captured samples and report, per
// OUTPUT, whether it lists and (for document outputs) fetches. Catches the class of bug that made FECI take
// many live round-trips: a request the adapter builds that the SPA never made — a missing/wrong query param
// or a missing POST body. Run this BEFORE attaching a source to a contributor, so their live test is the
// final confirmation and not the debugging loop. See consumers/... and the handoff workflow.
//
//   node scripts/replay-capture.mjs <bundle.json> <adapter.json>
//   node scripts/replay-capture.mjs --handoff <id> [--source <adapter.json>]   (fetches via api.habeas.dev)
//
// A handoff bundle keeps `samples[]` = { url, method, reqBody?, reqHeaders?, json } — query-param VALUES are
// un-redacted (so params compare), response VALUES are [type] placeholders but the SHAPE is intact.
import { readFileSync } from 'node:fs';
import { listInventory, fetchPdf, documentExt } from '../extension/src/runtime/inventory.js';
import { resolveOutput, outputsOf } from '../extension/src/lib/outputs.js';

const AUTH = { merged: {}, byPath: {}, ctx: {} };

const decode = (x) => { try { return decodeURIComponent(x); } catch (e) { return x; } };
const isPlaceholder = (x) => /^\[[^\]]*\]$/.test(String(x)); // a redaction token: [id#2], [date], [text], [amount:EUR]
const hasBody = (b) => b != null && String(b).trim() !== '' && String(b).trim().toLowerCase() !== 'null';

function norm(u) {
  const s = String(u).replace(/^https?:\/\/[^/]+/, '');
  const qi = s.indexOf('?');
  const path = (qi < 0 ? s : s.slice(0, qi)).split('/').map(decode);
  const params = {};
  for (const kv of (qi < 0 ? '' : s.slice(qi + 1)).split('&').filter(Boolean)) {
    const eq = kv.indexOf('='); params[decode(eq < 0 ? kv : kv.slice(0, eq))] = decode(eq < 0 ? '' : kv.slice(eq + 1));
  }
  return { path, params };
}
// Path segments match literally, but a redaction placeholder on EITHER side is a wildcard (a real card id
// vs the capture's [id#2]). Correlation usually makes them identical anyway.
const pathMatch = (a, b) => a.length === b.length && a.every((seg, i) => seg === b[i] || isPlaceholder(seg) || isPlaceholder(b[i]));
const valueOverlap = (cap, req) => Object.keys(cap).filter((k) => !isPlaceholder(cap[k]) && req[k] === cap[k]).length;

// Standard/transport headers the runtime sets itself or that carry no per-request meaning — ignored when
// checking which headers the SPA required. Everything else the SPA sent (e.g. a per-card encrypted-PAN) MUST
// be reproduced by the adapter, or the endpoint fails — exactly the FECI statement-PDF bug.
const STD_HEADERS = new Set(['accept', 'accept-encoding', 'accept-language', 'authorization', 'content-type', 'content-length', 'cookie', 'origin', 'referer', 'user-agent', 'connection', 'host', 'pragma', 'cache-control', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'access-control-allow-origin']);
const lowerKeys = (h) => { const o = {}; for (const k of Object.keys(h || {})) o[k.toLowerCase()] = h[k]; return o; };
const requiredHeaders = (capHeaders) => Object.keys(lowerKeys(capHeaders)).filter((k) => !STD_HEADERS.has(k) && !k.startsWith('access-control-'));
const missingHeaders = (capHeaders, reqHeaders) => { const rh = lowerKeys(reqHeaders); return requiredHeaders(capHeaders).filter((k) => rh[k] == null || rh[k] === ''); };

// A net(url, init) that answers ONLY when the adapter reproduces a request the SPA actually made: same
// method + path, every captured query-param KEY present in the request, and a body when the SPA sent one.
// Otherwise it records a precise issue (missing params / missing body / endpoint not captured) and 404s.
// issues = hard mismatches (wrong path, missing params/body → the request would fail); warnings = the SPA
// also sent a custom header the adapter omits (a header can't be PROVEN required from the capture, since the
// SPA sends some globally — so it is surfaced for review, not hard-failed).
export function buildNet(samples, issues, warnings, stats) {
  const idx = (samples || []).filter((s) => s && s.url).map((s) => ({
    ...norm(s.url), method: String(s.method || 'GET').toUpperCase(),
    reqBody: s.reqBody, reqHeaders: s.reqHeaders, resp: s.json !== undefined ? s.json : s.response, status: s.status || 200,
  }));
  const body = (resp, status) => ({ ok: status < 400, status, json: async () => resp, text: async () => (typeof resp === 'string' ? resp : JSON.stringify(resp)), blob: async () => new Blob([typeof resp === 'string' ? resp : JSON.stringify(resp || '')]), headers: { get: () => 'application/json' } });
  const miss = () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '', blob: async () => new Blob([]), headers: { get: () => null } });
  return async (url, init = {}) => {
    const req = { ...norm(url), method: String(init.method || 'GET').toUpperCase(), body: init.body, headers: init.headers || {} };
    const onPath = idx.filter((s) => s.method === req.method && pathMatch(s.path, req.path));
    if (!onPath.length) { issues.push(`no captured ${req.method} request for ${req.path.join('/')}`); return miss(); }
    const reproduced = onPath.filter((s) => Object.keys(s.params).every((k) => k in req.params) && (!hasBody(s.reqBody) || hasBody(req.body)));
    if (!reproduced.length) {
      const best = onPath[0];
      const missP = Object.keys(best.params).filter((k) => !(k in req.params));
      const missB = hasBody(best.reqBody) && !hasBody(req.body);
      issues.push(`${req.method} ${req.path.join('/')} does not match the SPA`
        + (missP.length ? ` — missing query params: ${missP.join(', ')}` : '')
        + (missB ? ' — missing request body (SPA sent one)' : ''));
      return miss();
    }
    reproduced.sort((a, b) => valueOverlap(b.params, req.params) - valueOverlap(a.params, req.params));
    const missH = missingHeaders(reproduced[0].reqHeaders, req.headers);
    if (missH.length && warnings) warnings.push(`${req.method} ${req.path.join('/')} — the SPA also sent header(s) the adapter omits: ${missH.join(', ')} (verify if required, e.g. a per-account token)`);
    if (stats) stats.matched++;
    return body(reproduced[0].resp, reproduced[0].status);
  };
}

async function replayOutput(adapter, out, samples) {
  const eff = resolveOutput(adapter, out.id);
  const issues = [], warnings = [], stats = { matched: 0 };
  const net = buildNet(samples, issues, warnings, stats);
  let docs = [];
  try { docs = await listInventory(eff, AUTH, net, {}); } catch (e) { issues.push('list threw: ' + (e && e.message || e)); }
  const listOk = docs.length > 0 && issues.length === 0;
  const hasDoc = !!documentExt(eff);
  let docOk = null;
  if (hasDoc) {
    // Test the document fetch on a REAL item — skip redaction truncation markers ("[+N more]") the redactor
    // leaves in place of elided array elements, which map to junk docs with a non-object _raw. A capture only
    // OPENS some documents, so prefer a listed doc whose fetch is actually in the capture (assets); fall back
    // to the first real one so the request is still exercised.
    const inCapture = (d) => { try { return !!(d && d._raw && (d._raw.id != null)); } catch (e) { return false; } };
    const real = docs.find((d) => d && d._raw && typeof d._raw === 'object' && inCapture(d)) || docs.find((d) => d && d._raw && typeof d._raw === 'object') || docs[0];
    if (!real) docOk = false;
    else {
      const before = { matched: stats.matched, issues: issues.length };
      try { docOk = !!(await fetchPdf(eff, AUTH, real, net)); }
      catch (e) {
        // A throw AFTER the request MATCHED a captured call, with no new hard issue, means the request was
        // right and only the (redacted) response payload could not be decoded — the request is verified.
        if (stats.matched > before.matched && issues.length === before.issues) {
          docOk = true; warnings.push('document request matched the capture; its base64 payload is redacted, so bytes were not decoded (request verified, not the file)');
        } else { docOk = false; if (issues.length === before.issues) issues.push('document fetch failed: ' + (e && e.message || e)); }
      }
    }
  }
  return { id: out.id, schema: eff.schema, listed: docs.length, listOk, hasDoc, docOk, issues, warnings, ok: listOk && (!hasDoc || docOk === true) };
}

// Run every output of `adapter` against `bundle` and return a structured report.
export async function replayCapture(bundle, adapter) {
  const samples = (bundle && (bundle.samples || bundle.requests)) || [];
  // Binary document fetches (PDFs) are captured in the ASSET buffer, not `samples` — index them too so a
  // document output's fetch can be verified (URL/params match; the bytes aren't kept).
  const assets = (bundle && bundle.assets) || [];
  const forNet = assets.length ? samples.concat(assets) : samples;
  const outputs = [];
  for (const o of outputsOf(adapter)) outputs.push(await replayOutput(adapter, o, forNet));
  return { ok: outputs.length > 0 && outputs.every((o) => o.ok), samples: samples.length, outputs };
}

function printReport(rep, name) {
  console.log(`\nReplay of ${name} against ${rep.samples} captured samples:\n`);
  for (const o of rep.outputs) {
    console.log(`  ${o.ok ? 'PASS' : 'FAIL'}  ${o.id} [${o.schema}]  listed=${o.listed}${o.hasDoc ? `  doc=${o.docOk ? 'ok' : 'FAIL'}` : ''}`);
    for (const i of o.issues) console.log(`         ✗ ${i}`);
    for (const w of (o.warnings || [])) console.log(`         ⚠ ${w}`);
  }
  console.log(`\n  ${rep.ok ? 'ALL OUTPUTS OK' : 'SOME OUTPUTS FAILED'} (${rep.outputs.length} outputs)\n`);
}

async function main(argv) {
  let bundle, adapter, name;
  const hi = argv.indexOf('--handoff');
  if (hi >= 0) {
    const id = argv[hi + 1];
    const token = readFileSync(`${process.env.HOME}/.habeas-admin-token`, 'utf8').trim();
    const h = await (await fetch(`https://api.habeas.dev/handoff/${id}?token=${token}`)).json();
    bundle = h.bundle; adapter = h.source; name = `handoff ${String(id).slice(0, 8)}`;
    const sf = argv.indexOf('--source');
    if (sf >= 0) { adapter = JSON.parse(readFileSync(argv[sf + 1], 'utf8')); name += ` + ${argv[sf + 1]}`; }
    if (!adapter) throw new Error('no source attached to the handoff — pass --source <adapter.json>');
  } else {
    if (argv.length < 2) throw new Error('usage: replay-capture.mjs <bundle.json> <adapter.json>  |  --handoff <id> [--source <adapter.json>]');
    let b = JSON.parse(readFileSync(argv[0], 'utf8')); bundle = b.bundle || b; // accept a full handoff json too
    adapter = JSON.parse(readFileSync(argv[1], 'utf8')); name = argv[1];
  }
  const rep = await replayCapture(bundle, adapter);
  printReport(rep, name);
  process.exit(rep.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).catch((e) => { console.error('replay error:', (e && e.message) || e); process.exit(2); });
