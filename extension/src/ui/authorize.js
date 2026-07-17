import { chrome } from '../lib/ext.js';
import { applyI18n, t } from '../lib/i18n.js';
import { upsert } from '../lib/config.js';
import { getAdapters } from '../adapters/index.js';
import { addGrant } from '../lib/grants.js';
import { appendLog } from '../lib/state.js';
import { sinkIdForOrigin, originHost } from '../lib/exthooks.js';
import { secureSinkHeaders } from '../lib/sinkheaders.js';

const $ = (s) => document.querySelector(s);
const reqId = new URLSearchParams(location.search).get('req');

async function init() {
  applyI18n();
  const o = await chrome.storage.session.get('extreq:' + reqId);
  const req = o['extreq:' + reqId];
  if (!req) { $('#status').textContent = t('authz_expired'); $('#allow').disabled = true; return; }
  $('#origin').textContent = req.origin;
  if (req.kind === 'list-sources') {
    // Consent to reveal WHICH sources are enabled (public metadata only) — no source/dest/scope to show.
    $('#intro').textContent = t('authz_ls_intro');
    $('#note').textContent = t('authz_ls_note');
    for (const id of ['row-source', 'row-dest', 'row-scope']) { const el = document.getElementById(id); if (el) el.hidden = true; }
    $('#deny').onclick = () => resolve(false, req);
    $('#allow').onclick = () => resolve(true, req);
    return;
  }
  const adapters = await getAdapters();
  const adapter = adapters[req.source];
  $('#source').textContent = (adapter && adapter.name) || req.source;
  $('#dest').textContent = req.sink.url;
  $('#scope').textContent = req.filter && req.filter.categories && req.filter.categories.length ? req.filter.categories.join(', ') : t('authz_scope_all');
  $('#deny').onclick = () => resolve(false, req);
  $('#allow').onclick = () => resolve(true, req, adapter);
}

async function resolve(allow, req, adapter) {
  const cleanup = () => chrome.storage.session.remove(['extreq:' + reqId, 'extls:' + req.origin]);
  if (!allow) {
    await appendLog({ kind: req.kind === 'list-sources' ? 'authz-listsources' : 'authz', origin: req.origin, source: req.source, status: 'denied' });
    await cleanup();
    $('#status').textContent = t('authz_denied'); disable();
    setTimeout(() => window.close(), 800);
    return;
  }
  if (req.kind === 'list-sources') {
    // A capability grant to see the enabled-source list — origin only, no route/sink/datasource.
    await addGrant({ id: 'g_' + crypto.randomUUID(), origin: req.origin, kind: 'list-sources', createdAt: new Date().toISOString(), lastUsedAt: null });
    await appendLog({ kind: 'authz-listsources', origin: req.origin, status: 'granted' });
    await cleanup();
    $('#status').textContent = t('authz_granted'); disable();
    setTimeout(() => window.close(), 900);
    return;
  }
  if (!adapter) { $('#status').textContent = t('authz_unknown_source'); return; }
  const sinkId = sinkIdForOrigin(req.origin);
  const sink = { id: sinkId, type: 'http', url: req.sink.url };
  if (req.sink.headers) sink.headers = req.sink.headers;
  if (req.filter && req.filter.categories && req.filter.categories.length) sink.accepts = { categories: req.filter.categories };
  // Pairing-token headers go to the encrypted secrets store (headersRef), never plaintext config.
  await upsert('sinks', await secureSinkHeaders(sink));
  await upsert('datasources', { id: req.source, adapter: req.source, enabled: true, options: {} });
  await upsert('routes', { id: req.source + '->' + sinkId, datasource: req.source, sink: sinkId, mode: 'external' });
  const grant = { id: 'g_' + crypto.randomUUID(), origin: req.origin, datasourceId: req.source, sinkId, filter: req.filter || null, createdAt: new Date().toISOString(), lastUsedAt: null };
  await addGrant(grant);
  await appendLog({ kind: 'authz', origin: req.origin, source: req.source, sink: originHost(req.origin), status: 'granted' });
  await chrome.storage.session.remove('extreq:' + reqId);
  $('#status').textContent = t('authz_granted'); disable();
  setTimeout(() => window.close(), 900);
}

function disable() { $('#allow').disabled = true; $('#deny').disabled = true; }

init();
