import { chrome } from '../lib/ext.js';
import { t } from '../lib/i18n.js';
import { validateAdapter } from '../adapters/validate.js';
import { listInventory, artifactKinds, fetchArtifact } from '../runtime/inventory.js';
import { ensureSiteFetch, recoverSession } from '../lib/pagefetch.js';
import { pickGroup } from './grouppicker.js';
import { renderPage } from '../lib/render.js';
import { loadAuth } from '../lib/authstore.js';
import { esc as escf } from '../lib/esc.js';
const fmt = (n) => (n == null || n === '' ? '' : String(n));

// Self-contained collapsible JSON tree (inline styles so it renders in any host page).
function jsonTree(v, key, depth = 0) {
  const label = key != null ? `<span style="color:#888">${escf(key)}</span>: ` : '';
  if (v === null) return `<div>${label}<span style="color:#8e44ad">null</span></div>`;
  if (typeof v !== 'object') {
    const color = typeof v === 'number' ? '#1565c0' : typeof v === 'boolean' ? '#8e44ad' : '#2e7d32';
    const shown = typeof v === 'string' ? '"' + (v.length > 200 ? v.slice(0, 200) + '…' : v) + '"' : String(v);
    return `<div>${label}<span style="color:${color}">${escf(shown)}</span></div>`;
  }
  const isArr = Array.isArray(v);
  let entries = isArr ? v.map((x, i) => [i, x]) : Object.entries(v);
  let more = '';
  if (entries.length > 100) { more = `<div style="color:#888">… +${entries.length - 100}</div>`; entries = entries.slice(0, 100); }
  const brief = `<span style="color:#888">${isArr ? '[' + v.length + ']' : '{' + Object.keys(v).length + '}'}</span>`;
  return `<details${depth < 1 ? ' open' : ''}><summary style="cursor:pointer">${label}${brief}</summary><div style="margin-left:10px;border-left:1px solid #ccc;padding-left:8px">${entries.map(([k, x]) => jsonTree(x, k, depth + 1)).join('') + more}</div></details>`;
}

// Render an HTML document (printable invoice) in a sandboxed iframe (no scripts/same-origin) so the
// user sees the actual page, not its source — with a toggle to inspect the raw HTML.
function renderHtmlDoc(el, html) {
  el.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', '');
  iframe.style.cssText = 'width:100%;height:340px;border:1px solid #ccc;background:#fff;border-radius:4px';
  iframe.srcdoc = html;
  const toggle = document.createElement('a'); toggle.href = '#'; toggle.textContent = t('view_source'); toggle.style.cssText = 'font-size:12px;display:inline-block;margin-top:4px';
  const pre = document.createElement('pre'); pre.textContent = html; pre.style.cssText = 'display:none;white-space:pre-wrap;max-height:240px;overflow:auto;font-size:11px;margin-top:4px';
  toggle.onclick = (e) => { e.preventDefault(); const show = pre.style.display === 'none'; pre.style.display = show ? 'block' : 'none'; toggle.textContent = t(show ? 'view_rendered' : 'view_source'); };
  el.append(iframe, document.createElement('br'), toggle, pre);
}

async function ensureHostPermission(hostUrl) {
  try {
    const origin = new URL(hostUrl).origin + '/*';
    if (!(await chrome.permissions.contains({ origins: [origin] }))) await chrome.permissions.request({ origins: [origin] });
  } catch (e) { /* optional_host_permissions may not be grantable here */ }
}

// Raw-JSON editor for a source, with an in-place TEST (list docs + preview a document). Edit the
// whole definition (fix pagination, hosts, fields, headers, referer…), test it against the live
// site without leaving, then save (validated). Returns the parsed adapter, or null if cancelled.
export function editJson(adapter) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999';
    const box = document.createElement('div'); box.className = 'card'; box.style.cssText = 'max-width:820px;width:94%;max-height:92vh;overflow:auto;margin:16px';
    const h = document.createElement('h3'); h.textContent = t('edit_json_title', [adapter.id || '']);
    const ta = document.createElement('textarea'); ta.value = JSON.stringify(adapter, null, 2); ta.spellcheck = false;
    ta.style.cssText = 'width:100%;height:300px;font-family:ui-monospace,monospace;font-size:12px;white-space:pre';
    const status = document.createElement('div'); status.className = 'muted'; status.style.margin = '6px 0';
    const results = document.createElement('div'); results.style.cssText = 'margin:6px 0';
    const row = document.createElement('div'); row.className = 'row'; row.style.cssText = 'margin-top:10px;gap:8px';
    const test = document.createElement('button'); test.textContent = t('je_test');
    const spacer = document.createElement('div'); spacer.style.flex = '1';
    const cancel = document.createElement('button'); cancel.textContent = t('consent_cancel');
    const save = document.createElement('button'); save.className = 'primary'; save.textContent = t('json_save');
    row.append(test, spacer, cancel, save); box.append(h, ta, row, status, results); ov.append(box); document.body.append(ov);
    const done = (v) => { ov.remove(); resolve(v); };
    cancel.onclick = () => done(null);
    ov.onclick = (e) => { if (e.target === ov) done(null); };

    const parse = () => { try { return { ok: true, obj: JSON.parse(ta.value) }; } catch (e) { status.textContent = t('json_badsyntax', [e.message]); return { ok: false }; } };
    save.onclick = () => {
      const p = parse(); if (!p.ok) return;
      const v = validateAdapter(p.obj);
      if (!v.ok) { status.textContent = t('json_invalid', [v.errors.join('; ')]); return; }
      done(p.obj);
    };
    test.onclick = () => runTest();

    async function runTest() {
      const p = parse(); if (!p.ok) return;
      const ad = p.obj;
      const v = validateAdapter(ad);
      if (!v.ok) { status.textContent = t('json_invalid', [v.errors.join('; ')]); return; }
      results.innerHTML = '';
      status.textContent = t('author_testing');
      try {
        await ensureHostPermission(ad.api.host);
        const auth = (await loadAuth(ad)) || { byPath: {}, merged: {}, ctx: {} };
        const net = await ensureSiteFetch(ad, { open: true });
        const groupId = await pickGroup(ad, auth, net); // grouped source (bank accounts/cards) → let the user choose
        const docs = await listInventory(ad, auth, net, { groupId });
        renderDocs(ad, auth, net, docs);
      } catch (e) {
        const msg = (e && e.message) || String(e);
        // CSRF / not-logged-in / bad-request (corrupted cookies) → reset cookies (if opted in) + clean tab.
        if (/csrf|4\d\d|5\d\d|forbidden|unauthor|sign ?in|log ?in|session|not logged/i.test(msg)) {
          const cleared = await recoverSession(ad);
          status.textContent = cleared ? t('cookies_cleared_login', [String(cleared)]) : t('login_in_tab');
        } else status.textContent = t('author_test_err', [msg]);
      }
    }

    function renderDocs(ad, auth, net, docs) {
      const MAX = 500;
      const rows = docs.slice(0, MAX).map((d) => `<tr data-i="${escf(d.internalId)}" style="cursor:pointer"><td>${escf((d.date || '').slice(0, 10))}</td><td>${escf(d.storeName || d.label || '')}</td><td style="text-align:right">${escf(fmt(d.total ?? d.amount))}</td><td>${escf(d.type || '')}</td></tr>`).join('');
      results.innerHTML = `<table style="width:100%;font-size:12px"><thead><tr><th>${t('th_date')}</th><th>${t('th_store')}</th><th style="text-align:right">${t('th_amount')}</th><th>${t('th_type')}</th></tr></thead><tbody>${rows}${docs.length > MAX ? `<tr><td colspan="4" class="muted">… +${docs.length - MAX}</td></tr>` : ''}</tbody></table><div id="je_doc" style="margin-top:8px;max-height:280px;overflow:auto;font-family:ui-monospace,monospace;font-size:12px"></div>`;
      // No site tab → the fetch ran from the extension, which can't set a same-origin Referer or ride
      // Cloudflare. Say so (a paged/referer-gated source only fully works from your tab).
      if (!net) { status.textContent = t('author_test_ok', [String(docs.length)]) + ' · ⚠ ' + t('je_no_tab'); return; }
      status.textContent = t('author_test_ok', [String(docs.length)]);
      if (docs.length && artifactKinds(ad).length) {
        const trs = results.querySelectorAll('tr[data-i]');
        docs.slice(0, trs.length).forEach((d, i) => { trs[i].onclick = () => preview(ad, auth, net, d, trs[i], docs.length); });
        preview(ad, auth, net, docs[0], trs[0], docs.length);
      }
    }

    async function preview(ad, auth, net, docItem, tr, total) {
      results.querySelectorAll('tr[data-i]').forEach((x) => { x.style.background = ''; });
      if (tr) tr.style.background = 'rgba(127,127,127,.18)';
      const el = results.querySelector('#je_doc'); if (el) el.innerHTML = '';
      status.textContent = t('author_test_ok', [String(total)]) + ' · ' + t('author_doc_fetching', [String(docItem.internalId)]);
      try {
        const kind = artifactKinds(ad, docItem).some((k) => k.kind === 'document') ? 'document' : 'data'; // per-doc: no invoice → preview the data
        const doc = await fetchArtifact(ad, auth, docItem, net, renderPage, kind);
        if (!el) { /* nothing */ }
        else if (doc.ext === 'pdf') { el.textContent = t('author_doc_pdf_size', [String(Math.round((await doc.blob.text()).length / 1024))]); }
        else if (doc.ext === 'html') { renderHtmlDoc(el, await doc.blob.text()); } // render the printable page, not its source
        else { const text = await doc.blob.text(); let data; try { data = JSON.parse(text); } catch (e) {} el.innerHTML = data !== undefined ? jsonTree(data) : escf(text.slice(0, 5000)); }
        status.textContent = t('author_test_ok', [String(total)]) + ' · ' + t('author_doc_via', [t('via_' + doc.via)]);
      } catch (e) {
        status.textContent = t('author_test_ok', [String(total)]) + ' · ' + t('author_doc_fail', [((e && e.message) || '').slice(0, 100)]);
      }
    }
  });
}
