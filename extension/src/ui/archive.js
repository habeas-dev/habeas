// Habeas — the ARCHIVE: a visual, friendly view of everything you've recovered. Additive to the popup
// (which stays the quick "sync + see new" surface). Reads the canonical store, groups documents into cards
// under a source→account tree, and opens any delivered file. Design decisions baked in:
//   A  a full-tab surface (this page), opened from the popup
//   B  grouping defaults to the source type — banks by month, the rest by category (switchable)
//   C  the root "Everything" is an INDEX of sources, not a merged timeline
//   D  a selection mode for batch actions
import { chrome } from '../lib/ext.js';
import { getConfig, saveConfig } from '../lib/config.js';
import { getAdapters } from '../adapters/index.js';
import { listSources, getSource, getStoreConfig, deleteSource } from '../lib/store.js';
import { useDriveStore, useFolderStore, useSinkStore, useHttpStore, folderStoreAvailable } from '../lib/storesetup.js';
import { mountSinkForm, connectSink, needsConnect, storeCapable } from './sinkform.js';
import { deliveredSet, getDocMeta } from '../lib/state.js';
import { isRetrievable, retrieveDelivered } from '../lib/retrieve.js';
import { detailView, hasDetail } from '../lib/detailview.js';
import { sinkAcceptsSource, groupLabelOf } from '../sinks/format.js';
import { resolveOutput } from '../lib/outputs.js';
import { artifactKinds } from '../runtime/inventory.js';
import { listSourceInto } from '../runtime/lister.js';
import { manageAccounts } from './accountpicker.js';
import { pickGroup } from './grouppicker.js';
import { hasConsent } from '../lib/consent.js';
import { loadAuth } from '../lib/authstore.js';
import { ensureSiteFetch, siteBaseUrl } from '../lib/pagefetch.js';
import { challengeUrlOf } from '../lib/render.js';
import { pushDiag } from '../lib/diag.js';
import { applyI18n, t } from '../lib/i18n.js';
import { esc } from '../lib/esc.js';

const $ = (s) => document.querySelector(s);
let ADAPTERS = {}, CFG = {}, RETRIEVABLE = [];
let LANG = 'en', ESLANG = false;
let INDEX = [];       // [{ base, ds, adapter, name, count, lastDate, primaryCat }]
let CUR = null;       // current source base, or null = the index
let CURDOCS = [];     // [{ base, dsId, adapter, internalId, record, delivered[], formats[] }]
let ACCOUNT = '';     // account (record.group) filter
let GROUPMODE = 'month';
let SELECTING = false;
const PICKED = new Set();
let STORE_LOCAL = false;        // the canonical store is still the default per-browser backend (→ first-run wizard)
let ONBOARD_DISMISSED = false;  // the user chose to keep the local store
let CURRENT_STOP = null;        // how to stop the in-progress action (local abort, or a background message)

// A long action (Refresh / Save / Send / Sync) started/ended — show the Stop button + the busy cursor.
function beginOp(stopFn) { CURRENT_STOP = stopFn; document.body.classList.add('saving'); const b = $('#astop'); if (b) { b.hidden = false; b.disabled = false; } }
function endOp() { CURRENT_STOP = null; document.body.classList.remove('saving'); const b = $('#astop'); if (b) b.hidden = true; }
// Live per-document progress from the background (Save/Send): patch each card in place as it downloads — the real
// date/amount, then the "Saved" pill — instead of only at the end.
function applyDocProgress(p) {
  if (!p || !Array.isArray(p.docs)) return;
  const entry = INDEX.find((x) => x.base === CUR);
  if (!entry || !entry.ds || entry.ds.id !== p.ds) return; // only the source being viewed
  for (const d of p.docs) {
    const i = CURDOCS.findIndex((r) => String(r.internalId) === String(d.internalId) && (d.stream == null || r._stream === d.stream));
    if (i < 0) continue;
    const r = CURDOCS[i];
    if (d.record) r.record = { ...r.record, ...d.record };
    if (d.delivered) { const sink = (CFG.sinks || []).find((s) => s.id === d.delivered); if (sink && !r.delivered.some((s) => s.id === sink.id)) r.delivered.push(sink); }
    const card = document.querySelector('.dcard[data-i="' + i + '"]');
    if (card) card.outerHTML = cardHtml(r); // cardHtml re-derives data-i (= i) + the picked state
  }
}

// ---- category → colour family + icon + label (self-contained; keeps 30 category strings out of the locales) ----
const F_RETAIL = 'retail', F_SERVICE = 'service', F_FINANCE = 'finance', F_OTHER = 'other';
const CAT = {
  grocery:{f:F_RETAIL,i:'🛒',es:'Supermercado',en:'Groceries'}, fuel:{f:F_RETAIL,i:'⛽',es:'Combustible',en:'Fuel'},
  sports:{f:F_RETAIL,i:'🏅',es:'Deporte',en:'Sports'}, fashion:{f:F_RETAIL,i:'👕',es:'Moda',en:'Fashion'},
  electronics:{f:F_RETAIL,i:'💻',es:'Electrónica',en:'Electronics'}, home:{f:F_RETAIL,i:'🏠',es:'Hogar',en:'Home'},
  diy:{f:F_RETAIL,i:'🔧',es:'Bricolaje',en:'DIY'}, pharmacy:{f:F_RETAIL,i:'💊',es:'Farmacia',en:'Pharmacy'},
  restaurant:{f:F_RETAIL,i:'🍽️',es:'Restaurante',en:'Restaurant'}, marketplace:{f:F_RETAIL,i:'📦',es:'Marketplace',en:'Marketplace'},
  travel:{f:F_RETAIL,i:'✈️',es:'Viajes',en:'Travel'}, entertainment:{f:F_RETAIL,i:'🎬',es:'Ocio',en:'Entertainment'},
  retail:{f:F_RETAIL,i:'🛍️',es:'Compras',en:'Retail'},
  energy:{f:F_SERVICE,i:'⚡',es:'Luz',en:'Energy'}, water:{f:F_SERVICE,i:'💧',es:'Agua',en:'Water'},
  telecom:{f:F_SERVICE,i:'📱',es:'Telefonía',en:'Telecom'}, utility:{f:F_SERVICE,i:'🔌',es:'Suministros',en:'Utilities'},
  tolls:{f:F_SERVICE,i:'🛣️',es:'Peajes',en:'Tolls'}, transport:{f:F_SERVICE,i:'🚆',es:'Transporte',en:'Transport'},
  insurance:{f:F_SERVICE,i:'🛡️',es:'Seguros',en:'Insurance'}, subscription:{f:F_SERVICE,i:'🔁',es:'Suscripción',en:'Subscription'},
  domains:{f:F_SERVICE,i:'🌐',es:'Dominios',en:'Domains'}, education:{f:F_SERVICE,i:'🎓',es:'Educación',en:'Education'},
  healthcare:{f:F_SERVICE,i:'🩺',es:'Salud',en:'Healthcare'}, government:{f:F_SERVICE,i:'🏛️',es:'Administración',en:'Government'},
  card:{f:F_FINANCE,i:'💳',es:'Tarjeta',en:'Card'}, cash:{f:F_FINANCE,i:'💵',es:'Efectivo',en:'Cash'},
  banking:{f:F_FINANCE,i:'🏦',es:'Banco',en:'Banking'}, investment:{f:F_FINANCE,i:'📈',es:'Inversión',en:'Investment'},
  pension:{f:F_FINANCE,i:'👴',es:'Pensión',en:'Pension'}, crypto:{f:F_FINANCE,i:'🪙',es:'Cripto',en:'Crypto'},
  loan:{f:F_FINANCE,i:'🏷️',es:'Préstamo',en:'Loan'},
  other:{f:F_OTHER,i:'📄',es:'Otros',en:'Other'},
};
const catOf = (c) => CAT[c] || CAT.other;
const catLabel = (c) => { const x = catOf(c); return ESLANG ? x.es : x.en; };

// ---- small helpers ----
const nameOf = (v) => (v && typeof v === 'object') ? (v.name || v.nombre || v.descripcion || '') : (v == null ? '' : String(v));
const storeOf = (r) => nameOf(r.store && r.store.name) || nameOf(r.storeName) || nameOf(r.issuer) || nameOf(r.counterparty) || nameOf(r.description) || '';
function titleOf(r) { return storeOf(r) || catLabel(r.category) || (r.type ? String(r.type) : '—'); }
function fmtMoney(n, cur) { try { return new Intl.NumberFormat(ESLANG ? 'es-ES' : 'en-US', { style: 'currency', currency: cur || 'EUR' }).format(n); } catch (e) { return (typeof n === 'number' ? n.toFixed(2) : n) + ' ' + (cur || 'EUR'); } }
function money(r) {
  let n = (typeof r.total === 'number') ? r.total : (typeof r.amount === 'number' ? r.amount : null);
  if (n == null) return { txt: '', cls: '' };
  const dir = r.direction; let cls = '';
  if (dir === 'out') { cls = 'neg'; n = -Math.abs(n); }
  else if (dir === 'in') { cls = 'pos'; n = Math.abs(n); }
  else if (n < 0) { cls = 'neg'; }
  const txt = (cls === 'pos' ? '+' : '') + fmtMoney(n, r.currency);
  return { txt, cls };
}
function dateShort(iso) { const d = new Date(iso); if (isNaN(d.getTime())) return String(iso || '').slice(0, 10); return d.toLocaleDateString(ESLANG ? 'es-ES' : 'en-US', { day: 'numeric', month: 'short' }); }
// Day + month + YEAR (short) — used on cards when the grouping doesn't already show the year (Category / Store).
function dateShortY(iso) { const d = new Date(iso); if (isNaN(d.getTime())) return String(iso || '').slice(0, 10); return d.toLocaleDateString(ESLANG ? 'es-ES' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric' }); }
function dateLong(iso) { const d = new Date(iso); if (isNaN(d.getTime())) return String(iso || '').slice(0, 10); return d.toLocaleDateString(ESLANG ? 'es-ES' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' }); }
function monthLabel(key) { const d = new Date(key + '-01T00:00:00'); if (isNaN(d.getTime())) return key; return d.toLocaleDateString(ESLANG ? 'es-ES' : 'en-US', { month: 'long', year: 'numeric' }); }

// A source with per-account groups (a bank) — or transaction/investment schema — defaults to month grouping.
function isBankish(adapter) {
  if (!adapter) return false;
  const schema = String(adapter.schema || '');
  if (/^(transaction|investment)/.test(schema)) return true;
  if (adapter.api && adapter.api.groups) return true;
  for (const s of adapter.streams || []) { const eff = resolveOutput(adapter, s.id); if (eff.api && eff.api.groups) return true; }
  return false;
}
function primaryCatOf(adapter) { return (adapter && adapter.categories && adapter.categories[0]) || (adapter && adapter.category) || 'other'; }
function groupAllowed(ds, group) { const labels = ds && ds.groupLabels; return !(labels && labels.length) || !group || labels.includes(group); }
// The captured session for a source (merged across sibling hosts sharing its registrable domain).
const getAuth = (adapter) => loadAuth(adapter);
// The effective GROUPED adapter (a bank with accounts): the base if it declares api.groups, else the first
// grouped stream. null = not grouped. And EVERY grouped stream (Raisin keeps products across several streams).
function groupedAdapterOf(adapter) {
  if (!adapter) return null;
  if (adapter.api && adapter.api.groups) return adapter;
  for (const s of adapter.streams || []) { const eff = resolveOutput(adapter, s.id); if (eff.api && eff.api.groups) return eff; }
  return null;
}
function groupedAdaptersOf(adapter) {
  if (!adapter) return [];
  const out = [];
  if (adapter.api && adapter.api.groups) out.push(adapter);
  for (const s of adapter.streams || []) { const eff = resolveOutput(adapter, s.id); if (eff.api && eff.api.groups) out.push(eff); }
  return out;
}

// Deliverable file formats for a store-key's stream: [{ id, ext, name }] — empty = record-only (no per-item file).
function fileFormatsFor(adapter, streamId) {
  if (!adapter) return [];
  if (!adapter.streams || !adapter.streams.length) {
    return artifactKinds(adapter).filter((k) => k.kind === 'document').map((k) => ({ id: '', ext: k.ext, name: (k.ext || 'file').toUpperCase() }));
  }
  const s = adapter.streams.find((x) => x.id === streamId); if (!s) return [];
  const formats = (s.formats && s.formats.length) ? s.formats : [{ id: '', name: '' }];
  const out = [];
  for (const f of formats) {
    const eff = resolveOutput(adapter, s.id + (f.id ? '/' + f.id : ''));
    const doc = artifactKinds(eff).find((k) => k.kind === 'document');
    if (doc) out.push({ id: f.id, ext: doc.ext, name: f.name || (doc.ext || 'file').toUpperCase() });
  }
  return out;
}

// ---- data load ----
// Lightweight local cache of the index metadata (sources, counts, last date, accounts) so the Archive paints
// REAL data instantly on open instead of empty rows/throbbers while the (possibly cloud) store is read. Refreshed
// in the background on every hydrate; the store stays the source of truth.
const CACHE_KEY = 'habeas:archive-cache';
async function loadCache() { try { return (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || null; } catch (e) { return null; } }
async function saveCache() {
  const sources = {};
  for (const s of INDEX) sources[s.base] = { name: s.name, primaryCat: s.primaryCat, count: s.count, lastDate: s.lastDate, accounts: s.accounts || [] };
  try { await chrome.storage.local.set({ [CACHE_KEY]: { at: Date.now(), sources } }); } catch (e) {}
}
// Paint an index straight from the cache — before any store call — so opening the Archive is never blank.
function seedIndexFromCache(cache) {
  const cs = (cache && cache.sources) || {};
  INDEX = Object.keys(cs).map((base) => {
    const c = cs[base];
    const ds = (CFG.datasources || []).find((d) => d.adapter === base) || (CFG.datasources || []).find((d) => d.id === base) || null;
    const adapter = (ds && ADAPTERS[ds.adapter]) || ADAPTERS[base] || null;
    return { base, ds, adapter, name: c.name || (adapter && adapter.name) || base, count: c.count, lastDate: c.lastDate, primaryCat: c.primaryCat || primaryCatOf(adapter), accounts: c.accounts || [], keys: [] };
  }).filter((s) => isRenderable(s.base) && (s.count > 0 || s.ds)).sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || '') || (b.count || 0) - (a.count || 0) || a.name.localeCompare(b.name));
}
// Build the index SHELL — source keys + adapter metadata, seeding count/lastDate/accounts from the cache so known
// sources show REAL numbers immediately (no throbber); genuinely-new sources start null and hydrate in. NO
// per-source item load here, so the page stays snappy even against a slow backend.
const hasDsFor = (base) => (CFG.datasources || []).some((d) => d.adapter === base || d.id === base);
const isRenderable = (base) => !!ADAPTERS[base] || hasDsFor(base); // a real, installed source (not an orphan key)
async function buildIndex() {
  const keys = await listSources();
  const cs = ((await loadCache()) || {}).sources || {};
  const storeBases = [...new Set(keys.map((k) => String(k).split(':')[0]))];
  // ORPHAN store keys — a base with stored data but NO installed adapter AND no configured datasource, left over
  // from a removed/renamed source (raisin-es → raisin). Don't render them, and auto-clean their store data.
  const orphans = storeBases.filter((b) => !isRenderable(b));
  if (orphans.length) { for (const key of keys) { if (orphans.includes(String(key).split(':')[0])) { try { await deleteSource(key); } catch (e) {} } } }
  // Also list every ENABLED, installed datasource — even with no stored docs yet — so the Archive is a complete
  // source manager: a freshly-installed source shows up and can be Refreshed to pull its first documents (this is
  // what lets the Archive replace the popup's Sources list).
  const cfgBases = (CFG.datasources || []).filter((d) => d.enabled !== false && ADAPTERS[d.adapter]).map((d) => d.adapter);
  const bases = [...new Set([...storeBases, ...cfgBases])].filter(isRenderable);
  INDEX = bases.map((base) => {
    const ds = (CFG.datasources || []).find((d) => d.adapter === base) || (CFG.datasources || []).find((d) => d.id === base) || null;
    const adapter = (ds && ADAPTERS[ds.adapter]) || ADAPTERS[base] || null;
    const c = cs[base] || {};
    return { base, ds, adapter, name: (adapter && adapter.name) || base, count: (c.count != null ? c.count : null), lastDate: (c.lastDate != null ? c.lastDate : null), primaryCat: primaryCatOf(adapter), accounts: c.accounts || [], keys: keys.filter((k) => String(k).split(':')[0] === base) };
  }).sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || '') || (b.count || 0) - (a.count || 0) || a.name.localeCompare(b.name));
}
// Load each source's live count + last date one at a time, yielding between them so the shell stays responsive,
// and patch that source's card/rail node in place (throbber → value). When all are known, drop empty sources
// and resort by recency. A sequence guard aborts a run superseded by a reinstall/refresh.
let hydrateSeq = 0;
async function hydrateIndex() {
  const seq = ++hydrateSeq;
  $('#astatus').textContent = t('archive_loading');
  const grid = document.querySelector('.idx-grid'); if (grid) grid.classList.add('hydrating');
  for (const s of INDEX) {
    if (seq !== hydrateSeq) return; // a newer refresh started
    let count = 0, lastDate = ''; const accSet = new Set();
    for (const key of s.keys) {
      const src = await getSource(key).catch(() => null); if (!src || !src.items) continue;
      for (const e of Object.values(src.items)) { if (e.gone) continue; const g = e.record && e.record.group; if (!groupAllowed(s.ds, g)) continue; count++; const dt = (e.record && e.record.date) || ''; if (dt > lastDate) lastDate = dt; if (g) accSet.add(g); }
    }
    s.count = count; s.lastDate = lastDate; s.accounts = [...accSet].sort();
    patchMeta(s);
    await new Promise((r) => setTimeout(r, 0)); // yield → paint between sources
  }
  if (seq !== hydrateSeq) return;
  // Keep sources with documents AND every configured source (even at 0 docs — the user can Refresh it); drop
  // only orphan store keys that have no live docs and no datasource. Docs-first by recency, then empties by name.
  INDEX = INDEX.filter((s) => isRenderable(s.base) && (s.count > 0 || s.ds)).sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || '') || (b.count || 0) - (a.count || 0) || a.name.localeCompare(b.name));
  $('#astatus').textContent = '';
  if (CUR === null) renderIndex(); else renderRail(); // reflect final order (index) / final counts (rail)
  await saveCache(); // persist the fresh numbers + accounts for an instant next open
}
// Refresh ONLY the current source in place: recompute its stored docs + its own tree count/date and re-render,
// WITHOUT re-hydrating (re-counting) every other source. A single-source action (Refresh, Save, Send, Accounts)
// must never make the whole tree flash throbbers. Reserve buildIndex()+hydrateIndex() for Sync-all / reinstalls.
async function reloadCurrent() {
  if (!CUR) return;
  const keys = (await listSources()).filter((k) => String(k).split(':')[0] === CUR);
  await loadDocs(CUR);
  const s = INDEX.find((x) => x.base === CUR);
  if (s) {
    s.keys = keys;
    s.ds = (CFG.datasources || []).find((d) => d.adapter === CUR) || (CFG.datasources || []).find((d) => d.id === CUR) || s.ds; // pick up a just-saved account allow-list
    let count = 0, lastDate = ''; const accSet = new Set();
    for (const key of keys) {
      const src = await getSource(key).catch(() => null); if (!src || !src.items) continue;
      for (const e of Object.values(src.items)) { if (e.gone) continue; const g = e.record && e.record.group; if (!groupAllowed(s.ds, g)) continue; count++; const dt = (e.record && e.record.date) || ''; if (dt > lastDate) lastDate = dt; if (g) accSet.add(g); }
    }
    s.count = count; s.lastDate = lastDate; s.accounts = [...accSet].sort();
    patchMeta(s);
    saveCache(); // keep the cache fresh after a single-source refresh
  }
  renderRail(); renderDocs();
}
function patchMeta(s) {
  const q = '[data-src="' + ((window.CSS && CSS.escape) ? CSS.escape(s.base) : s.base) + '"]';
  document.querySelectorAll('.srccard' + q + ' .sc-s').forEach((el) => { el.textContent = s.count == null ? '' : (t('n_documents', [String(s.count)]) + (s.lastDate ? ' · ' + dateLong(s.lastDate) : '')); });
  document.querySelectorAll('.node' + q + ' .cnt').forEach((el) => { el.textContent = s.count == null ? '' : String(s.count); });
}

async function loadDocs(base) {
  const keys = (await listSources()).filter((k) => String(k).split(':')[0] === base);
  const entry = INDEX.find((x) => x.base === base) || {};
  const ds = entry.ds, adapter = entry.adapter;
  const dsId = (ds && ds.id) || base;
  const known = await getDocMeta(base).catch(() => ({}));
  const deliveredCache = {};
  const rows = [];
  for (const key of keys) {
    const src = await getSource(key).catch(() => null); if (!src || !src.items) continue;
    const stream = String(key).split(':')[1] || '';
    const formats = fileFormatsFor(adapter, stream);
    for (const [internalId, e] of Object.entries(src.items)) {
      if (e.gone) continue;
      const record = enrich(e.record || {}, known[internalId]);
      if (!groupAllowed(ds, record.group)) continue;
      const delivered = [];
      for (const sink of RETRIEVABLE) {
        const ck = dsId + '::' + sink.id;
        const set = deliveredCache[ck] || (deliveredCache[ck] = await deliveredSet(dsId, sink.id).catch(() => ({})));
        if (set[internalId]) delivered.push(sink);
      }
      rows.push({ base, dsId, adapter, internalId, record, delivered, formats, _stream: stream });
    }
  }
  rows.sort((a, b) => ((a.record.date || '') < (b.record.date || '') ? 1 : -1));
  CURDOCS = rows;
}
function enrich(r, k) {
  if (!k) return r;
  const out = { ...r };
  if (k.date && !/^\d{4}-\d{2}-\d{2}/.test(out.date || '')) out.date = k.date;
  if (typeof k.total === 'number' && out.total == null) out.total = k.total;
  return out;
}

// ---- rendering: rail ----
const NO_ACCOUNT = '__habeas_no_account__'; // sentinel ACCOUNT = documents in a grouped source with no account
// Accounts of a source: from the currently-loaded docs when available, else the cached list (so the tree shows
// accounts instantly on open, before this source's documents finish loading).
function accountsOf(base) {
  const fromDocs = [...new Set(CURDOCS.filter((r) => r.base === base).map((r) => r.record.group).filter(Boolean))].sort();
  if (fromDocs.length) return fromDocs;
  const s = INDEX.find((x) => x.base === base);
  return (s && s.accounts && s.accounts.length) ? s.accounts.slice() : [];
}
function hasUngrouped(base) { return CURDOCS.some((r) => r.base === base && !r.record.group); }
// Selectable buckets in the account tree = the real accounts + a "No account" bucket when there are docs with
// no associated account (so they're reachable, not hidden by the multi-account gate).
function bucketsOf(base) { const a = accountsOf(base); return hasUngrouped(base) ? [...a, NO_ACCOUNT] : a; }
const accLabel = (a) => (a === NO_ACCOUNT ? t('archive_no_account') : a);
function renderRail() {
  const rail = $('#rail');
  // No "Everything" root and no "All accounts" subnode: a source node IS its "all accounts" view (clicking it
  // clears the account filter). Mixing documents across sources isn't meaningful, so there's no aggregate node.
  let html = `<div class="rlabel">${esc(t('archive_sources'))}</div>`;
  for (const s of INDEX) {
    const on = CUR === s.base;
    html += node(s.base, catOf(s.primaryCat).i, s.name, s.count, on, catOf(s.primaryCat).f);
    if (on) {
      const buckets = bucketsOf(s.base);
      if (buckets.length > 1) {
        html += '<div class="subtree">';
        for (const a of buckets) html += `<button class="subnode${ACCOUNT === a ? ' on' : ''}${a === NO_ACCOUNT ? ' none' : ''}" data-acc="${esc(a)}"><span class="sd"></span>${esc(accLabel(a))}</button>`;
        html += '</div>';
      }
    }
  }
  rail.innerHTML = html;
}
function node(id, icon, name, count, on, fam) {
  const cnt = count == null ? '<span class="thb" style="width:11px;height:11px;border-width:2px"></span>' : String(count);
  return `<button class="node${on ? ' on' : ''}" data-src="${esc(id)}">
    <span class="av tile ${fam}" style="width:27px;height:27px;font-size:15px">${icon}</span>
    <span class="nm">${esc(name)}</span><span class="cnt">${cnt}</span></button>`;
}

// First-run assistant: shown at the top of the index while the canonical store is still the default per-browser
// backend. Explains the "archive" (canonical store), recommends a cloud folder for multi-device access, and sets
// it up in one click — reusing lib/storesetup.js (the tested moveStoreTo/driveSignIn/putHandle primitives).
const SINK_ICONS = { dropbox: '🗄️', drive: '☁️', webdav: '🌐', s3: '🪣', http: '🔗' };
function wizardCard() {
  if (!STORE_LOCAL || ONBOARD_DISMISSED) return '';
  const sinkOf = (type) => (CFG.sinks || []).find((s) => s.type === type);
  // Dropbox is the RECOMMENDED cloud store (Drive's drive.file scope only sees files it created — awkward). If a
  // Dropbox sink is already set up, one-click move to it; otherwise the primary button opens Settings to add one.
  const dbx = sinkOf('dropbox');
  const btns = [];
  btns.push(dbx
    ? `<button class="wz-btn primary" data-store="dropbox" data-sink="${esc(dbx.id)}">🗄️ ${esc(t('onboard_dropbox'))}</button>`
    : `<button class="wz-btn primary" data-add="dropbox">🗄️ ${esc(t('onboard_dropbox_setup'))}</button>`);
  // Any other already-configured sink backend can host the store too (reuse its credentials).
  for (const type of ['webdav', 's3']) { const s = sinkOf(type); if (s) btns.push(`<button class="wz-btn" data-store="${type}" data-sink="${esc(s.id)}">${SINK_ICONS[type]} ${esc(t('onboard_use_sink', [type.toUpperCase()]))}</button>`); }
  btns.push(`<button class="wz-btn" data-store="drive">☁️ ${esc(t('onboard_drive'))}</button>`);
  if (folderStoreAvailable()) btns.push(`<button class="wz-btn" data-store="folder">📁 ${esc(t('onboard_folder'))}</button>`);
  btns.push(`<button class="wz-btn" data-add="">➕ ${esc(t('onboard_add'))}</button>`);
  btns.push(`<button class="wz-btn ghost" data-store="dismiss">${esc(t('onboard_dismiss'))}</button>`);
  return `<div class="wizard" id="wizard">
    <div class="wz-head"><span class="wz-ic">🗄️</span><div><h2>${esc(t('onboard_title'))}</h2><p>${esc(t('onboard_body'))}</p></div></div>
    <p class="wz-cloud">☁️ ${esc(t('onboard_cloud'))}</p>
    <div class="wz-actions">${btns.join('')}</div>
    <div class="wz-status" id="wz-status"></div>
  </div>`;
}
async function onStoreSetup(kind, sinkId) {
  if (kind === 'dismiss') { ONBOARD_DISMISSED = true; try { await chrome.storage.local.set({ 'habeas:onboard-dismissed': true }); } catch (e) {} renderIndex(); return; }
  if (kind === 'advanced') { chrome.runtime.openOptionsPage(); return; }
  const wiz = $('#wizard'); if (wiz) wiz.classList.add('busy');
  const st = $('#wz-status'); if (st) st.textContent = t('onboard_moving');
  try {
    const n = kind === 'drive' ? await useDriveStore()
      : kind === 'folder' ? await useFolderStore()
      : await useSinkStore(kind, sinkId); // dropbox / webdav / s3 → reuse the configured sink's credentials
    STORE_LOCAL = false;
    if (st) st.textContent = t('onboard_moved', [String(n || 0)]);
    await buildIndex(); renderRail(); renderIndex(); hydrateIndex(); // store moved → re-read from the new backend
  } catch (e) {
    if (st) st.textContent = t('onboard_err', [(e && e.message) || String(e)]);
    if (wiz) wiz.classList.remove('busy');
  }
}
// Create ANY destination (sink) from the assistant, reusing the shared sink form (ui/sinkform.js — the same one
// Settings uses). On save: OAuth-connect if needed, and if the destination can host the archive, move it there.
function openSinkModal(preType) {
  const ov = document.createElement('div'); ov.className = 'wz-modal';
  const box = document.createElement('div'); box.className = 'card wz-modalbox';
  const h = document.createElement('h3'); h.textContent = t('onboard_add_title');
  const p = document.createElement('p'); p.className = 'muted'; p.style.margin = '4px 0 12px'; p.textContent = t('onboard_add_sub');
  const formRoot = document.createElement('div');
  const status = document.createElement('div'); status.className = 'wz-status';
  const foot = document.createElement('div'); foot.className = 'row'; foot.style.cssText = 'justify-content:flex-end;margin-top:12px;gap:8px';
  const cancel = document.createElement('button'); cancel.textContent = t('cancel');
  const close = () => ov.remove();
  cancel.onclick = close;
  foot.append(cancel);
  box.append(h, p, formRoot, status, foot);
  ov.append(box); document.body.append(ov);
  ov.onclick = (e) => { if (e.target === ov) close(); };
  mountSinkForm(formRoot, {
    type: preType,
    onSaved: async (sink) => {
      try {
        if (needsConnect(sink.type)) { status.textContent = t('onboard_connecting'); await connectSink(sink); }
        if (storeCapable(sink.type)) {
          status.textContent = t('onboard_moving');
          const n = sink.type === 'drive' ? await useDriveStore()
            : sink.type === 'http' ? await useHttpStore(sink.url)
            : await useSinkStore(sink.type, sink.id);
          STORE_LOCAL = false; close();
          await buildIndex(); renderRail(); renderIndex(); hydrateIndex(); // store moved → re-read
        } else {
          CFG = await getConfig(); // a delivery-only destination (download / local folder) — added, can't host the archive
          status.textContent = t('onboard_sink_added');
        }
      } catch (e) { status.textContent = t('onboard_err', [(e && e.message) || String(e)]); }
    },
  });
}

// ---- rendering: index (Everything) ----
function renderIndex() {
  CUR = null; ACCOUNT = ''; SELECTING = false; PICKED.clear();
  $('#main').classList.remove('selecting');
  const m = $('#main');
  if (!INDEX.length) { m.innerHTML = wizardCard() + emptyState(t('archive_empty_title'), t('archive_empty_sub')); return; }
  let html = wizardCard() + `<div class="idx-head"><h1>${esc(t('archive_index_title'))}</h1><p>${esc(t('archive_index_sub'))}</p></div>`;
  html += '<div class="idx-grid">';
  for (const s of INDEX) {
    const c = catOf(s.primaryCat);
    const sub = s.count == null ? '<span class="thb"></span>' : esc(t('n_documents', [String(s.count)]) + (s.lastDate ? ' · ' + dateLong(s.lastDate) : ''));
    html += `<button class="srccard" data-src="${esc(s.base)}">
      <span class="tile ${c.f}">${c.i}</span>
      <span class="sc-m"><span class="sc-t">${esc(s.name)}</span><span class="sc-s">${sub}</span></span></button>`;
  }
  html += '</div>';
  m.innerHTML = html;
}
function emptyState(title, sub) { return `<div class="empty"><div class="big">🗂️</div><div style="font-family:var(--font-head);font-weight:600;font-size:17px;color:var(--ink)">${esc(title)}</div><p style="margin-top:6px">${esc(sub)}</p></div>`; }
function loadingPane() { return `<div class="loadpane"><span class="thb big"></span><span>${esc(t('archive_loading'))}</span></div>`; }

// ---- rendering: one source's documents ----
function visibleDocs() {
  const q = ($('#q').value || '').trim().toLowerCase();
  return CURDOCS.filter((r) => {
    if (ACCOUNT === NO_ACCOUNT) { if (r.record.group) return false; } // the "No account" bucket
    else if (ACCOUNT && r.record.group !== ACCOUNT) return false;
    if (!q) return true;
    return [titleOf(r.record), r.record.date, r.record.type, catLabel(r.record.category), r.record.group].join(' ').toLowerCase().includes(q);
  });
}
function groupDocs(docs) {
  const map = new Map();
  const keyOf = (r) => {
    if (GROUPMODE === 'category') return { k: r.record.category || 'other', label: catLabel(r.record.category) };
    if (GROUPMODE === 'store') { const s = storeOf(r.record) || '—'; return { k: s, label: s }; }
    const mk = String(r.record.date || '').slice(0, 7) || '0000-00'; return { k: mk, label: monthLabel(mk) };
  };
  for (const r of docs) { const { k, label } = keyOf(r); if (!map.has(k)) map.set(k, { k, label, items: [] }); map.get(k).items.push(r); }
  const groups = [...map.values()];
  groups.sort((a, b) => (GROUPMODE === 'month') ? b.k.localeCompare(a.k) : b.items.length - a.items.length);
  return groups;
}
// Render the header + controls immediately, then APPEND the month/category groups in batches (yielding between
// them) so a source with thousands of documents paints progressively instead of freezing the tab. A sequence
// guard drops a run superseded by a newer one (group-by switch, account change, a keystroke in search).
let docsSeq = 0;
async function renderDocs() {
  const seq = ++docsSeq;
  const m = $('#main');
  const entry = INDEX.find((x) => x.base === CUR) || {};
  // Multi-account source: don't mix accounts — wait for the user to pick one in the tree before showing rows.
  // The gate lives INSIDE the doc area so the source-level controls (Refresh, Accounts) stay available.
  const buckets = bucketsOf(CUR);
  const gate = buckets.length > 1 && !ACCOUNT;
  const docs = gate ? [] : visibleDocs();
  const delivered = CURDOCS.filter((r) => r.delivered.length).length;
  let head = `<div class="crumbs"><span class="tile ${catOf(entry.primaryCat).f}" style="width:26px;height:26px;font-size:14px;border-radius:7px">${catOf(entry.primaryCat).i}</span> <b>${esc(entry.name || CUR)}</b>${ACCOUNT ? ' <span>›</span> ' + esc(accLabel(ACCOUNT)) : ''}</div>`;
  head += `<div class="summ"><span class="chip">📄 <b>${gate ? CURDOCS.length : docs.length}</b> ${esc(t('archive_docs_word'))}</span>`;
  if (delivered) head += `<span class="chip">${esc(t('archive_saved_n', [String(delivered)]))}</span>`;
  head += `<span class="chip legend" title="${esc(t('archive_legend'))}" tabindex="0" aria-label="${esc(t('archive_legend'))}">ℹ</span>`;
  head += '</div>';
  const gb = (mode, label) => `<button data-gb="${mode}" class="${GROUPMODE === mode ? 'on' : ''}">${esc(label)}</button>`;
  const sinks = compatibleSinks(entry.adapter);
  const saveGrp = sinks.length ? `<span class="savegrp"><span class="sl">${esc(t('archive_save_to'))}</span>${sinks.map((s) => `<button class="savebtn" data-save="${esc(s.id)}" title="${esc(t('archive_save_hint', [sinkLabel(s)]))}">${sinkIcon(s)} ${esc(sinkLabel(s))}</button>`).join('')}<span class="refwrap"><button id="save-more" class="savebtn caret" aria-haspopup="menu" aria-label="${esc(t('archive_redownload'))}" title="${esc(t('archive_redownload'))}">▾</button><div id="savemenu" class="refmenu" hidden role="menu"><div class="menuhead">${esc(t('archive_redownload'))}</div>${sinks.map((s) => `<button data-redl="${esc(s.id)}"><span class="ic">${sinkIcon(s)}</span> ${esc(t('archive_redownload_to', [sinkLabel(s)]))}</button>`).join('')}</div></span></span>` : '';
  // "Refresh" = the old "List documents": incremental list into the store (delta only). Its caret opens the
  // two alternative modes — a full-history re-scan and a no-network reload from the store.
  const refreshBtn = (entry.ds ? `<span class="refwrap">
      <button id="refresh" class="refbtn" title="${esc(t('archive_refresh_hint', [entry.name || CUR]))}"><span class="ic">↻</span> ${esc(t('archive_refresh'))}</button>
      <button id="refresh-more" class="refbtn caret" aria-haspopup="menu" aria-label="${esc(t('archive_refresh_more'))}" title="${esc(t('archive_refresh_more'))}">▾</button>
      <div id="refmenu" class="refmenu" hidden role="menu">
        <button data-refmode="full" title="${esc(t('archive_refresh_full_hint'))}"><span class="ic">↻</span> ${esc(t('archive_refresh_full'))}</button>
        <button data-refmode="store" title="${esc(t('archive_load_store_hint'))}"><span class="ic">📦</span> ${esc(t('archive_load_store'))}</button>
      </div></span>` : '');
  // Accounts (allow-list) manager — grouped sources only. Lets the user choose which accounts to track from
  // the Archive, so the popup's account picker isn't needed.
  const acctBtn = (entry.ds && groupedAdapterOf(entry.adapter)) ? `<button id="accts" class="refbtn" title="${esc(t('archive_accounts_hint'))}"><span class="ic">👤</span> ${esc(t('archive_accounts'))}</button>` : '';
  head += `<div class="docbar"><div class="groupby">${gb('month', t('group_month'))}${gb('category', t('group_category'))}${gb('store', t('group_store'))}</div>
    <div class="docbar-r">${acctBtn}${refreshBtn}${saveGrp}<button id="seltoggle" class="selbtn${SELECTING ? ' on' : ''}">${esc(SELECTING ? t('archive_sel_done') : t('archive_select'))}</button></div></div>`;
  // Selection bar: send the picked documents to any compatible destination (with a caret for "Re-download from
  // site" per destination), open their saved files, or clear.
  const sendBtns = sinks.map((s) => `<button class="go" data-sendsel="${esc(s.id)}">${sinkIcon(s)} ${esc(t('archive_send_to', [sinkLabel(s)]))}</button>`).join('');
  const sendMore = sinks.length ? `<span class="refwrap"><button id="sel-more" class="go caret2" aria-haspopup="menu" aria-label="${esc(t('archive_redownload'))}" title="${esc(t('archive_redownload'))}">▾</button><div id="selmenu" class="refmenu up" hidden role="menu"><div class="menuhead">${esc(t('archive_redownload'))}</div>${sinks.map((s) => `<button data-sendredl="${esc(s.id)}"><span class="ic">${sinkIcon(s)}</span> ${esc(t('archive_redownload_to', [sinkLabel(s)]))}</button>`).join('')}</div></span>` : '';
  const selbar = `<div class="selbar"><b id="selcount">0</b> <span>${esc(t('archive_selected_suffix'))}</span>
    <button class="pick" id="selall">${esc(t('archive_select_all'))}</button>
    <button class="pick" id="selnone">${esc(t('archive_select_none'))}</button>
    ${sendBtns}${sendMore}
    <button class="go" id="selopen">${esc(t('archive_open_saved'))}</button>
    <button class="clr" id="selclear">${esc(t('archive_clear'))}</button></div>`;
  m.innerHTML = head + '<div id="arch-groups"></div>' + selbar;
  m.classList.toggle('selecting', SELECTING);
  const container = document.getElementById('arch-groups');
  if (gate) { container.innerHTML = `<div class="empty"><div class="big">👈</div><div style="font-family:var(--font-head);font-weight:600;font-size:17px;color:var(--ink)">${esc(t('archive_pick_account'))}</div><p style="margin-top:6px">${esc(t('archive_pick_account_sub', [String(buckets.length)]))}</p></div>`; return; }
  if (!docs.length) { container.innerHTML = emptyState(t('no_documents'), t('archive_empty_source')); return; }
  const groups = groupDocs(docs);
  for (let gi = 0; gi < groups.length; gi++) {
    if (seq !== docsSeq) return; // superseded → stop appending
    container.insertAdjacentHTML('beforeend', groupHtml(groups[gi], entry));
    if (gi % 5 === 4 && gi + 1 < groups.length) await new Promise((r) => setTimeout(r, 0)); // yield every 5 groups
  }
  updateSelCount();
}
function groupHtml(g, entry) {
  const net = g.items.reduce((a, r) => { const v = (typeof r.record.total === 'number' ? r.record.total : r.record.amount); if (typeof v !== 'number') return a; const dir = r.record.direction; return a + (dir === 'out' ? -Math.abs(v) : dir === 'in' ? Math.abs(v) : v); }, 0);
  const showNet = GROUPMODE === 'month' && isBankish(entry.adapter);
  return `<div class="mgroup"><div class="mhead"><h4>${esc(g.label)}</h4><span class="line"></span><span class="mtot">${showNet ? esc(fmtMoney(net, currencyOf(g.items))) : t('n_documents', [String(g.items.length)])}</span></div><div class="cards">${g.items.map(cardHtml).join('')}</div></div>`;
}
function currencyOf(items) { const r = items.find((x) => x.record.currency); return (r && r.record.currency) || 'EUR'; }
function cardHtml(r) {
  const i = CURDOCS.indexOf(r);
  const c = catOf(r.record.category);
  const mv = money(r.record);
  const fmts = r.formats.length ? r.formats.map((f) => `<span class="fmt">${esc((f.ext || '').toUpperCase())}</span>`).join('') : '';
  const st = r.delivered.length
    ? `<span class="status sent" title="${esc(t('archive_status_saved_hint', [r.delivered.map(sinkLabel).join(', ')]))}"><span class="d"></span>${esc(t('archive_status_saved'))}</span>`
    : `<span class="status new" title="${esc(t('archive_status_local_hint'))}"><span class="d"></span>${esc(t('archive_status_local'))}</span>`;
  // Month grouping already shows the year in the group header; Category/Store don't → put the year on the card.
  const dstr = GROUPMODE === 'month' ? dateShort(r.record.date) : dateShortY(r.record.date);
  const sub = [dstr, r.record.group && ACCOUNT === '' ? esc(r.record.group) : ''].filter(Boolean).join(' · ');
  return `<button class="dcard${PICKED.has(r.internalId) ? ' picked' : ''}" data-i="${i}">
    <span class="chk">✓</span>
    <span class="tile ${c.f}">${c.i}</span>
    <span class="dmeta"><span class="dtitle">${esc(titleOf(r.record))}</span>
      <span class="dsub">${esc(sub)} ${fmts}</span></span>
    <span class="damt"><span class="v ${mv.cls} tnum">${esc(mv.txt)}</span>${st}</span></button>`;
}

// ---- drawer ----
function openDrawer(r) {
  if (!r) return;
  const c = catOf(r.record.category);
  $('#dw-tile').className = 'tile ' + c.f; $('#dw-tile').textContent = c.i;
  $('#dw-title').textContent = titleOf(r.record);
  $('#dw-sub').textContent = [dateLong(r.record.date), r.record.group].filter(Boolean).join(' · ');
  const mv = money(r.record);
  const rows = [];
  if (mv.txt) rows.push([t('archive_field_amount'), mv.txt, mv.cls]);
  if (r.record.category) rows.push([t('archive_field_category'), catLabel(r.record.category)]);
  if (r.record.group) rows.push([t('archive_field_account'), r.record.group]);
  const cp = nameOf(r.record.counterparty) || nameOf(r.record.description); if (cp) rows.push([t('archive_field_concept'), cp]);
  if (r.record.type) rows.push([t('archive_field_type'), String(r.record.type)]);
  if (r.formats.length) rows.push([t('archive_field_files'), r.formats.map((f) => (f.ext || '').toUpperCase()).join(' · ')]);
  let body = `<dl class="kvx">${rows.map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd${cls ? ` style="color:var(--${cls === 'neg' ? 'neg' : 'pos'})"` : ''}>${esc(String(v))}</dd>`).join('')}</dl>`;
  // actions: open each delivered FILE (real). A record-only movement (a bank line) has no file — its data
  // rode the manifest — so it gets an honest note, not a broken "open". Nothing delivered → the sync note.
  const acts = [];
  if (r.formats.length) for (const sink of r.delivered) for (const f of r.formats) { const pv = PREVIEWABLE.has((f.ext || '').toLowerCase()); acts.push(actBtn(pv ? '👁' : '⬇', t(pv ? 'archive_preview_from' : 'open_from', [sinkLabel(sink)]), (r.formats.length > 1 ? f.name : f.ext.toUpperCase()), `open:${sink.id}:${f.ext}`, true)); }
  if (acts.length) body += `<div class="actions">${acts.join('')}</div>`;
  else if (r.delivered.length) body += `<div class="actions-note">${esc(t('archive_delivered_data'))}</div>`;
  else body += `<div class="actions-note">${esc(t('archive_no_dest'))}</div>`;
  body += `<div class="detail" id="dw-detail" hidden></div>`; // filled from the stored JSON detail on demand
  body += `<button class="rawtoggle" id="rawtoggle">${esc(t('archive_raw_show'))}</button><pre class="raw" id="rawbox" hidden></pre>`;
  const b = $('#dw-body'); b.innerHTML = body;
  void loadStoredDetail(r); // fetch the order's JSON breakdown (items, payment, refund) and render it
  b.dataset.i = String(CURDOCS.indexOf(r));
  const rb = $('#rawbox'); rb.textContent = JSON.stringify(r.record, null, 2);
  $('#rawtoggle').onclick = () => { rb.hidden = !rb.hidden; };
  b.querySelectorAll('[data-act]').forEach((el) => { el.onclick = () => {
    const [, sinkId, ext] = el.dataset.act.split(':');
    const sink = (CFG.sinks || []).find((s) => s.id === sinkId);
    if (sink && PREVIEWABLE.has((ext || '').toLowerCase())) previewFile(r, sink, ext); // inline preview in the Archive
    else openFile(r, sinkId, ext);                                                     // other types → the full-tab viewer
  }; });
  $('#drawer').classList.add('on'); $('#scrim').classList.add('on'); $('#drawer').setAttribute('aria-hidden', 'false');
}
function actBtn(icon, label, sub, act, primary) {
  return `<button class="abtn ${primary ? 'primary' : ''}" data-act="${esc(act)}"><span class="ai">${icon}</span><span class="grow">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></button>`;
}
function closeDrawer() { $('#drawer').classList.remove('on'); $('#scrim').classList.remove('on'); $('#drawer').setAttribute('aria-hidden', 'true'); DW_SEQ++; }
// On opening a document, pull its stored JSON detail (the `data` artifact saved next to the file) back from a
// retrievable destination and render the order breakdown — line items, payment, refund. Fetched on demand, so
// the full detail shows even though the compact store record only keeps date/total. No-ops silently when the
// source has no JSON detail, nothing was delivered to a readable destination, or the file can't be found.
let DW_SEQ = 0;
async function loadStoredDetail(r) {
  const el = $('#dw-detail'); if (!el) return;
  if (!r.adapter || !artifactKinds(r.adapter).some((k) => k.kind === 'data')) return; // this source emits no JSON detail
  const sink = (r.delivered || []).find(isRetrievable); if (!sink) return;            // nothing readable to fetch from
  const seq = ++DW_SEQ;
  el.hidden = false;
  el.innerHTML = `<div class="dloading"><span class="thb"></span> ${esc(t('archive_detail_loading'))}</div>`;
  try {
    const res = await retrieveDelivered(sink, r.adapter, r.record, 'json', { only: true });
    if (seq !== DW_SEQ) return; // a newer drawer opened
    if (!res || !res.blob) { el.hidden = true; return; }
    const view = detailView(JSON.parse(await res.blob.text()));
    if (!hasDetail(view)) { el.hidden = true; return; }
    el.innerHTML = detailHtml(view, r.record);
  } catch (e) { if (seq === DW_SEQ) el.hidden = true; } // not JSON / not found → just no panel
}
function detailHtml(view, record) {
  const cur = view.currency || record.currency || 'EUR';
  let html = '';
  if (view.items.length) {
    const rows = view.items.map((it) => {
      const price = it.price != null ? `<td class="num">${esc(fmtMoney(Number(it.price), cur))}</td>` : '<td class="num"></td>';
      const ret = it.returned ? `<span class="ret">${esc(it.returned)}</span>` : '';
      return `<tr><td>${esc(it.name || '—')}${ret}</td>${price}</tr>`;
    }).join('');
    html += `<div class="dsec"><h4>${esc(t('archive_detail_items', [String(view.items.length)]))}</h4><table class="ditems"><tbody>${rows}</tbody></table></div>`;
  }
  const m = view.meta, rows = [];
  if (m.paymentMethod) rows.push([t('archive_field_payment'), String(m.paymentMethod) + (m.paymentLast4 ? ' ···· ' + m.paymentLast4 : '')]);
  if (m.returnStatus) rows.push([t('archive_field_return'), String(m.returnStatus)]);
  if (m.refundTotal != null) rows.push([t('archive_field_refund'), fmtMoney(Number(m.refundTotal), cur)]);
  if (rows.length) html += `<div class="dsec"><dl class="kvx">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join('')}</dl></div>`;
  return html;
}
const sinkLabel = (s) => s.name || s.id || s.type;
// Software destinations the background can deliver to unattended (mirrors the Auto-sync tab). 'download' and
// 'local-folder' need a page/user context, so they're not offered as an on-demand archive save.
const AUTO_SINK_TYPES = new Set(['drive', 'http', 'webdav', 's3', 'dropbox']);
const SINK_ICON = { drive: '☁️', dropbox: '🗄️', s3: '🪣', webdav: '🌐', http: '🔗' };
const sinkIcon = (s) => SINK_ICON[s.type] || '📤';
function compatibleSinks(adapter) { return adapter ? (CFG.sinks || []).filter((s) => AUTO_SINK_TYPES.has(s.type) && sinkAcceptsSource(s, adapter)) : []; }
// Save = deliver every NOT-yet-saved document of the CURRENT source to a destination, reusing the background's
// full pipeline (session → list new → fetch → write → ledger). Honest about a missing session.
async function deliver(sinkId, opts = {}) {
  const entry = INDEX.find((x) => x.base === CUR); if (!entry || !entry.ds) return;
  const sink = (CFG.sinks || []).find((s) => s.id === sinkId); if (!sink) return;
  beginOp(() => chrome.runtime.sendMessage({ type: 'habeas:stop' })); // Stop → abort the background op
  $('#astatus').textContent = t('archive_saving');
  const onStatus = (ch, area) => { const v = area === 'local' && ch['habeas:status'] && ch['habeas:status'].newValue; if (v && v.msg) $('#astatus').textContent = v.msg; };
  chrome.storage.onChanged.addListener(onStatus);
  try {
    // opts.force → "Re-download from site": re-fetch + re-deliver even already-delivered docs (bypass the ledger skip).
    const r = await chrome.runtime.sendMessage({ type: 'habeas:deliver', datasource: entry.ds.id, sink: sinkId, force: !!opts.force });
    if (r && r.ok && r.status === 'done') $('#astatus').textContent = r.new ? t('archive_saved_ok', [String(r.new), sinkLabel(sink)]) : t('archive_save_none');
    else if (r && r.status === 'nosession') $('#astatus').textContent = t('archive_save_nosession', [entry.name]);
    else $('#astatus').textContent = t('archive_save_err', [(r && r.error) || 'error']);
  } catch (e) { $('#astatus').textContent = t('archive_save_err', [(e && e.message) || String(e)]); }
  finally {
    chrome.storage.onChanged.removeListener(onStatus);
    endOp();
    await reloadCurrent(); // just this source — not a full-tree re-hydrate
  }
}
// Pull NEW documents for the current source into the store — no destination. The Archive becomes self-sufficient:
// the user lists/refreshes in place (session/login/challenges handled by the background) before deciding where to send.
async function refreshSource(mode) {
  const entry = INDEX.find((x) => x.base === CUR); if (!entry || !entry.ds) return;
  const adapter = entry.adapter;
  if (!(await hasConsent(adapter))) { $('#astatus').textContent = t('needs_consent'); return; }
  const auth = await getAuth(adapter);
  if (!auth) { try { await ensureSiteFetch(adapter, { open: true }); } catch (e) {} $('#astatus').textContent = t('archive_refresh_nosession', [entry.name]); return; }
  const aborter = new AbortController();
  beginOp(() => { try { aborter.abort(); } catch (e) {} }); // Stop → abort the in-page list
  const btn = $('#refresh'); if (btn) { btn.disabled = true; btn.classList.add('spin'); }
  $('#astatus').textContent = mode === 'full' ? t('archive_rescanning') : t('archive_refreshing');
  try {
    const net = await ensureSiteFetch(adapter, { open: true });
    // EXACTLY the same list core as the classic "List documents" (runtime/lister.js), run in THIS page: saved
    // allow-list or the transient account picker (pickGroup), incremental unless mode:'full', → the store.
    const res = await listSourceInto(adapter, {
      auth, net, ds: entry.ds, mode, signal: aborter.signal,
      pickGroup: (eff, a, n) => pickGroup(eff, a, n),
      onProgress: (sid, eff, sk, { page, docs }) => { $('#astatus').textContent = t('status_listing_page', [entry.name, String(page || ''), String((docs && docs.length) || '')]); },
    });
    $('#astatus').textContent = res.new ? t('archive_refresh_ok', [String(res.new)]) : t('archive_refresh_none');
  } catch (e) {
    const msg = (e && e.message) || String(e);
    pushDiag(adapter.id, { phase: 'list', message: msg });
    const cUrl = challengeUrlOf(msg);
    if (cUrl || /captcha-delivery|datadome|geo\.captcha|challenge-platform|__cf_chl|cf-browser-verification|just a moment|akam[ai]/i.test(msg)) {
      try { await chrome.tabs.create({ url: cUrl || siteBaseUrl(adapter), active: true }); } catch (e2) {}
      $('#astatus').textContent = t('archive_refresh_challenge', [entry.name]);
    } else if (/csrf|4\d\d|5\d\d|forbidden|unauthor|sign ?in|log ?in|session|not logged/i.test(msg)) {
      $('#astatus').textContent = t('archive_refresh_nosession', [entry.name]);
    } else { $('#astatus').textContent = t('archive_refresh_err', [msg]); }
  } finally {
    endOp();
    const b = $('#refresh'); if (b) { b.disabled = false; b.classList.remove('spin'); }
    await reloadCurrent(); // just this source — not a full-tree re-hydrate
  }
}
// "Load from store": re-read the current source from the local canonical store and re-render — no network.
// Picks up documents that arrived via background auto-sync while this tab was open.
async function reloadFromStore() {
  if (!CUR) return;
  $('#astatus').textContent = t('archive_loading');
  await reloadCurrent();
  $('#astatus').textContent = '';
}
// Dropdown menus (Refresh modes, Save re-download). Opening one closes the others.
function toggleMenu(id) { const m = $('#' + id); if (!m) return; const willOpen = m.hidden; closeMenus(); m.hidden = !willOpen; }
function closeMenus() { document.querySelectorAll('.refmenu').forEach((m) => { m.hidden = true; }); }
function openFile(r, sinkId, ext) {
  const url = chrome.runtime.getURL(`src/ui/docview.html?sink=${encodeURIComponent(sinkId)}&src=${encodeURIComponent(r.base)}&id=${encodeURIComponent(r.internalId)}${ext ? '&ext=' + encodeURIComponent(ext) : ''}`);
  chrome.tabs.create({ url });
}
// Inline preview inside the Archive: fetch the delivered file's blob from its sink and render it in an overlay
// (PDF/HTML in an iframe, images in an <img>) — no new tab. Falls back to the full-tab viewer for other types.
const PREVIEWABLE = new Set(['pdf', 'html', 'htm', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
// The MIME each previewable ext must carry so the browser renders (not downloads) a blob: URL in an iframe/img.
const PREVIEW_MIME = { pdf: 'application/pdf', html: 'text/html', htm: 'text/html', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
let PV_URL = null, PV_CTX = null;
function closePreview() {
  const ov = $('#preview'); if (ov) ov.hidden = true;
  const body = $('#pv-body'); if (body) body.innerHTML = '';
  if (PV_URL) { try { URL.revokeObjectURL(PV_URL); } catch (e) {} PV_URL = null; }
  PV_CTX = null;
}
async function previewFile(r, sink, ext) {
  PV_CTX = { r, sink, ext };
  const ov = $('#preview'); const body = $('#pv-body'); const title = $('#pv-title');
  if (!ov || !body) { openFile(r, sink.id, ext); return; } // no overlay in the DOM → fall back
  if (title) title.textContent = titleOf(r.record) + (r.record.date ? ' · ' + String(r.record.date).slice(0, 10) : '');
  body.innerHTML = `<div class="pv-msg"><span class="thb big"></span> ${esc(t('archive_preview_loading'))}</div>`;
  ov.hidden = false;
  try {
    const res = await retrieveDelivered(sink, r.adapter, r.record, ext);
    if (PV_CTX && PV_CTX.r !== r) return; // a newer preview started
    if (!res || !res.blob) { body.innerHTML = `<div class="pv-msg">${esc(t('archive_preview_fail'))}</div>`; return; }
    if (PV_URL) { try { URL.revokeObjectURL(PV_URL); } catch (e) {} }
    const kind = (res.ext || ext || '').toLowerCase();
    // A sink (Dropbox &c.) hands the blob back as application/octet-stream, so an <iframe> would DOWNLOAD it
    // instead of rendering. Re-wrap it with the MIME the extension implies so the browser previews it inline.
    const mime = PREVIEW_MIME[kind];
    const blob = (mime && res.blob.type !== mime) ? new Blob([res.blob], { type: mime }) : res.blob;
    PV_URL = URL.createObjectURL(blob);
    body.innerHTML = /^(png|jpe?g|webp|gif|svg)$/.test(kind)
      ? `<img class="pv-img" src="${PV_URL}" alt="" />`
      : `<iframe class="pv-frame" src="${PV_URL}"></iframe>`;
  } catch (e) { body.innerHTML = `<div class="pv-msg">${esc((e && e.message) || String(e))}</div>`; }
}
// Manage which accounts a grouped source tracks (the persisted allow-list), straight from the Archive — so
// the popup's account picker is no longer needed. Enumerates every grouped stream's accounts, saves ds.groups
// + ds.groupLabels, then reloads (the tree + what's shown honor the new allow-list).
// Returns true if the user saved an account selection, false if cancelled / not applicable / no session.
// opts.reload (default true) refreshes the view after saving; refreshSource passes false (it lists + reloads next).
async function onManageAccounts(opts = {}) {
  const entry = INDEX.find((x) => x.base === CUR); if (!entry || !entry.ds || !entry.adapter) return false;
  const gAdapters = groupedAdaptersOf(entry.adapter); if (!gAdapters.length) return false;
  if (!(await hasConsent(entry.adapter))) { $('#astatus').textContent = t('needs_consent'); return false; }
  const auth = await getAuth(entry.adapter);
  if (!auth) { try { await ensureSiteFetch(entry.adapter, { open: true }); } catch (e) {} $('#astatus').textContent = t('login_wait'); return false; }
  $('#astatus').textContent = t('accounts_loading');
  let net; try { net = await ensureSiteFetch(entry.adapter, { open: false }); } catch (e) {}
  let selected;
  try { selected = await manageAccounts(gAdapters, auth, net, (entry.ds.groups) || null); }
  catch (e) { $('#astatus').textContent = t('accounts_failed') + (e && e.message ? ' — ' + e.message : ''); return false; }
  if (selected == null) { $('#astatus').textContent = ''; return false; } // cancelled
  const cfg = await getConfig();
  const d = (cfg.datasources || []).find((x) => x.id === entry.ds.id);
  if (d) { d.groups = selected.map((g) => String(g.id)); d.groupLabels = selected.map((g) => groupLabelOf(g)).filter(Boolean); await saveConfig(cfg); }
  CFG = cfg;
  $('#astatus').textContent = t('accounts_saved', [String(selected.length)]);
  if (opts.reload === false) return true; // caller (refreshSource) will list + reload
  // The allow-list changed what's visible → refresh index + docs. If the current account was dropped, reset it.
  await buildIndex();
  if (ACCOUNT && d && d.groupLabels && d.groupLabels.length && !d.groupLabels.includes(ACCOUNT)) ACCOUNT = '';
  if (CUR) { await loadDocs(CUR); renderRail(); renderDocs(); }
  hydrateIndex();
  return true;
}
// Send the HAND-PICKED documents (selection mode) to a destination, from the store. Delivers each record's
// manifest and re-fetches its file when the source can still produce it (background sendStoredDocs).
async function sendSelected(sinkId, opts = {}) {
  const entry = INDEX.find((x) => x.base === CUR); if (!entry || !entry.ds) return;
  const sink = (CFG.sinks || []).find((s) => s.id === sinkId); if (!sink) return;
  // Pass the picked docs' RECORDS (which THIS page already read from the archive) to the background — so it
  // doesn't have to re-read the store, which the service worker can't always do (a Dropbox/folder-backed archive
  // isn't readable from the background the way it is from a page). The background just fetches files + delivers.
  const docs = CURDOCS.filter((r) => PICKED.has(r.internalId)).map((r) => ({ internalId: r.internalId, record: r.record, stream: r._stream || '' }));
  if (!docs.length) { $('#astatus').textContent = t('nothing_selected'); return; }
  beginOp(() => chrome.runtime.sendMessage({ type: 'habeas:stop' })); // Stop → abort the background op
  $('#astatus').textContent = t('archive_sending_n', [String(docs.length)]);
  const onStatus = (ch, area) => { const v = area === 'local' && ch['habeas:status'] && ch['habeas:status'].newValue; if (v && v.msg) $('#astatus').textContent = v.msg; };
  chrome.storage.onChanged.addListener(onStatus);
  try {
    // opts.force → "Re-download from site": re-fetch the selected docs' files + details fresh (opens the site tab).
    const r = await chrome.runtime.sendMessage({ type: 'habeas:send', datasource: entry.ds.id, sink: sinkId, docs, force: !!opts.force });
    if (r && r.ok && r.status === 'done') {
      if (r.sent) $('#astatus').textContent = t('archive_sent_ok', [String(r.sent), sinkLabel(sink)]);
      else if (!r.found) $('#astatus').textContent = t('archive_send_notfound') + (r.debug ? ' · ' + r.debug : '');   // none passed (unexpected)
      else $('#astatus').textContent = t('archive_send_incompat', [sinkLabel(sink)]);   // found but the sink's filter rejected them
    }
    else if (r && r.status === 'nosession') $('#astatus').textContent = t('archive_save_nosession', [entry.name]);
    else $('#astatus').textContent = t('archive_save_err', [(r && r.error) || 'error']);
  } catch (e) { $('#astatus').textContent = t('archive_save_err', [(e && e.message) || String(e)]); }
  finally {
    chrome.storage.onChanged.removeListener(onStatus);
    endOp();
    PICKED.clear(); SELECTING = false;
    await reloadCurrent(); // just this source — not a full-tree re-hydrate
  }
}

// ---- selection (batch) ----
function updateSelCount() { const el = $('#selcount'); if (el) el.textContent = String(PICKED.size); }
// Select all currently-visible documents (respecting the account/search filter), or clear the selection.
function selectAllVisible(on) {
  if (on) for (const r of visibleDocs()) PICKED.add(r.internalId); else PICKED.clear();
  document.querySelectorAll('.dcard').forEach((card) => { const r = CURDOCS[+card.dataset.i]; if (r) card.classList.toggle('picked', PICKED.has(r.internalId)); });
  updateSelCount();
}
function toggleSelecting() {
  SELECTING = !SELECTING; if (!SELECTING) PICKED.clear();
  renderDocs();
}

// ---- navigation ----
async function openSource(base) {
  CUR = base; ACCOUNT = ''; SELECTING = false; PICKED.clear();
  $('#main').innerHTML = loadingPane(); // instant throbber while the source's documents load
  renderRail();
  await loadDocs(base);
  if (CUR !== base) return; // navigated away mid-load
  const entry = INDEX.find((x) => x.base === base);
  GROUPMODE = isBankish(entry && entry.adapter) ? 'month' : 'category';
  renderRail(); renderDocs();
}
function goIndex() { CUR = null; renderRail(); renderIndex(); }

// ---- events ----
function wire() {
  $('#opts').onclick = () => chrome.runtime.openOptionsPage();
  { const l = $('#logs'); if (l) l.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/activity.html') }); }
  { const s = $('#astop'); if (s) s.onclick = () => { if (CURRENT_STOP) CURRENT_STOP(); s.disabled = true; $('#astatus').textContent = t('stopping'); }; }
  // The status line is single-line-clamped (ellipsis); mirror its text into the title so hover shows the full message.
  { const as = $('#astatus'); if (as && typeof MutationObserver !== 'undefined') { const mo = new MutationObserver(() => { as.title = as.textContent || ''; }); mo.observe(as, { childList: true, characterData: true, subtree: true }); } }
  // Live per-document progress from the background (Save/Send) → patch cards as they download.
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch['habeas:doc-progress']) applyDocProgress(ch['habeas:doc-progress'].newValue); });
  { const c = $('#pv-close'); if (c) c.onclick = closePreview; }
  { const tb = $('#pv-tab'); if (tb) tb.onclick = () => { if (PV_CTX) openFile(PV_CTX.r, PV_CTX.sink.id, PV_CTX.ext); }; }
  $('#dw-close').onclick = closeDrawer;
  $('#scrim').onclick = closeDrawer;
  $('#q').oninput = () => { if (CUR) renderDocs(); else renderIndex(); };
  $('#sync').onclick = onSync;
  // the brand returns to the source index (there's no "Everything" node in the tree anymore)
  document.querySelectorAll('.abar .logo, .abar .brand').forEach((el) => { el.style.cursor = 'pointer'; el.onclick = goIndex; });
  // rail delegation
  $('#rail').onclick = (ev) => {
    const acc = ev.target.closest('[data-acc]'); if (acc) { ACCOUNT = acc.dataset.acc; renderRail(); renderDocs(); return; }
    const src = ev.target.closest('[data-src]'); if (src) openSource(src.dataset.src);
  };
  // main delegation (index cards, group-by, select toggle, doc cards)
  $('#main').onclick = (ev) => {
    const wa = ev.target.closest('[data-add]'); if (wa) { openSinkModal(wa.dataset.add || undefined); return; }
    const ws = ev.target.closest('[data-store]'); if (ws) { onStoreSetup(ws.dataset.store, ws.dataset.sink); return; }
    const sc = ev.target.closest('.srccard'); if (sc) { openSource(sc.dataset.src); return; }
    const gb = ev.target.closest('[data-gb]'); if (gb) { GROUPMODE = gb.dataset.gb; renderDocs(); return; }
    const sv = ev.target.closest('[data-save]'); if (sv) { deliver(sv.dataset.save); return; }
    const rl = ev.target.closest('[data-redl]'); if (rl) { closeMenus(); deliver(rl.dataset.redl, { force: true }); return; }
    const ss = ev.target.closest('[data-sendsel]'); if (ss) { sendSelected(ss.dataset.sendsel); return; }
    const sr = ev.target.closest('[data-sendredl]'); if (sr) { closeMenus(); sendSelected(sr.dataset.sendredl, { force: true }); return; }
    if (ev.target.closest('#sel-more')) { toggleMenu('selmenu'); return; }
    const rm = ev.target.closest('[data-refmode]'); if (rm) { closeMenus(); if (rm.dataset.refmode === 'full') refreshSource('full'); else reloadFromStore(); return; }
    if (ev.target.closest('#refresh-more')) { toggleMenu('refmenu'); return; }
    if (ev.target.closest('#save-more')) { toggleMenu('savemenu'); return; }
    if (ev.target.closest('#accts')) { onManageAccounts(); return; }
    if (ev.target.closest('#refresh')) { closeMenus(); refreshSource(); return; }
    if (ev.target.closest('#selall')) { selectAllVisible(true); return; }
    if (ev.target.closest('#selnone')) { selectAllVisible(false); return; }
    if (ev.target.closest('#seltoggle')) { toggleSelecting(); return; }
    if (ev.target.closest('#selclear')) { PICKED.clear(); SELECTING = false; renderDocs(); return; }
    if (ev.target.closest('#selopen')) { batchOpen(); return; }
    const card = ev.target.closest('.dcard'); if (card) {
      const r = CURDOCS[+card.dataset.i]; if (!r) return;
      if (SELECTING) { if (PICKED.has(r.internalId)) PICKED.delete(r.internalId); else PICKED.add(r.internalId); card.classList.toggle('picked'); updateSelCount(); }
      else openDrawer(r);
    }
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if ($('#preview') && !$('#preview').hidden) { closePreview(); return; } closeDrawer(); closeMenus(); } });
  // Dismiss any open dropdown (Refresh modes, Save re-download) on a click outside a split button (the #main
  // handler keeps the just-clicked one open; this catches everything else).
  document.addEventListener('click', (e) => { if (!e.target.closest('.refwrap')) closeMenus(); });
  // A source was (re)installed → drop our cached adapters and re-read, so the Archive reflects the NEW
  // definition instead of the copy loaded when this tab opened.
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch['habeas:sources-rev']) return;
    (async () => {
      ADAPTERS = await getAdapters(); CFG = await getConfig(); RETRIEVABLE = (CFG.sinks || []).filter((s) => isRetrievable(s));
      await buildIndex();
      if (CUR && INDEX.some((x) => x.base === CUR)) { await loadDocs(CUR); renderRail(); renderDocs(); } else { renderRail(); renderIndex(); }
      hydrateIndex();
    })().catch(() => {});
  });
}
function batchOpen() {
  const picks = CURDOCS.filter((r) => PICKED.has(r.internalId) && r.delivered.length && r.formats.length);
  const CAP = 12;
  picks.slice(0, CAP).forEach((r) => openFile(r, r.delivered[0].id, r.formats[0].ext));
  $('#astatus').textContent = picks.length > CAP ? t('archive_open_capped', [String(CAP), String(picks.length)]) : '';
}

async function onSync() {
  const b = $('#sync');
  b.disabled = true; beginOp(() => chrome.runtime.sendMessage({ type: 'habeas:sync-stop' })); // Stop → stop the sweep
  $('#astatus').textContent = t('sync_all_running');
  const onStatus = (ch, area) => { const v = area === 'local' && ch['habeas:status'] && ch['habeas:status'].newValue; if (v && v.msg) $('#astatus').textContent = v.msg; };
  chrome.storage.onChanged.addListener(onStatus);
  try {
    const r = await chrome.runtime.sendMessage({ type: 'habeas:sync-all' });
    if (r && r.ok && (r.status === 'done' || r.status === 'stopped')) $('#astatus').textContent = t('sync_all_done', [String(r.new || 0), String(r.sources || 0)]);
    else if (r && r.status === 'busy') $('#astatus').textContent = t('sync_all_running');
    else $('#astatus').textContent = t('sync_all_err', [(r && r.error) || 'error']);
  } catch (e) { $('#astatus').textContent = t('sync_all_err', [(e && e.message) || String(e)]); }
  finally {
    chrome.storage.onChanged.removeListener(onStatus);
    b.disabled = false; endOp();
    await buildIndex(); if (CUR) { await loadDocs(CUR); renderRail(); renderDocs(); } else { renderRail(); renderIndex(); } hydrateIndex();
  }
}

async function init() {
  applyI18n();
  try { LANG = chrome.i18n.getUILanguage() || 'en'; } catch (e) { LANG = 'en'; }
  ESLANG = LANG.toLowerCase().startsWith('es');
  ADAPTERS = await getAdapters();
  CFG = await getConfig();
  RETRIEVABLE = (CFG.sinks || []).filter((s) => isRetrievable(s));
  // First-run assistant: the store is still the default per-browser backend AND the user hasn't dismissed it.
  try { STORE_LOCAL = ((await getStoreConfig()).backend || 'local') === 'local'; } catch (e) {}
  try { ONBOARD_DISMISSED = !!(await chrome.storage.local.get('habeas:onboard-dismissed'))['habeas:onboard-dismissed']; } catch (e) {}
  wire();
  const want = new URLSearchParams(location.search).get('src');
  // 1) Paint REAL data instantly from the local cache — sources, counts, accounts — before touching the store.
  const cache = await loadCache();
  if (cache && Object.keys((cache.sources) || {}).length) {
    seedIndexFromCache(cache);
    renderRail();
    if (!(want && INDEX.some((x) => x.base === want))) renderIndex(); // (a deep-link opens its source below)
  }
  // 2) Reconcile against the store (buildIndex re-seeds counts from cache too → still no throbbers for known
  //    sources), then hydrate live counts in the background and refresh the cache.
  await buildIndex();
  renderRail();
  if (want && INDEX.some((x) => x.base === want)) await openSource(want);
  else renderIndex();
  hydrateIndex();
}
init();
