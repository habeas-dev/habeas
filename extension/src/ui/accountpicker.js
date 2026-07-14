// Persistent ACCOUNT FILTER for grouped sources (a bank with many accounts/cards). Unlike grouppicker
// (a transient "which account, this time?" choice), this lets the user pick — and SAVE — which accounts
// are offered at all. The saved allow-list (datasource.groups) is then enforced everywhere data is offered:
// listing, auto and sweep only ever touch the chosen accounts. Returns the selected id array, or null on cancel.
import { listGroups } from '../runtime/inventory.js';
import { t } from '../lib/i18n.js';
import { esc } from '../lib/esc.js';

// Generic across grouped sources: ING exposes `iban`, WiZink `mask`, CaixaBank `card` — show whichever,
// masked to its last 4, plus the account type when present. Falls back to the raw id so a label is never empty.
const last4 = (s) => (String(s || '').match(/(\w{4})\s*$/) || [, ''])[1];
const accLabel = (g) => {
  const m = g.iban || g.mask || g.card || g.cardMask || g.alias;
  return [g.name || g.alias, m ? '· …' + last4(m) : '', g.type ? '· ' + String(g.type).toLowerCase().replace(/_/g, ' ') : '']
    .filter(Boolean).join(' ').trim() || String(g.id || '');
};

// Show the checklist. `current` = the saved allow-list (array of ids), or null/undefined = "all offered"
// (every box checked by default). Only accounts that have an id (are actually listable) are shown.
export async function manageAccounts(adapter, auth, net, current) {
  if (!(adapter.api && adapter.api.groups)) return null;
  let groups = [];
  try { groups = (await listGroups(adapter, auth, net)).filter((g) => g.id != null && g.id !== ''); } catch (e) { throw e; }
  if (!groups.length) return null;
  const checked = (id) => (current == null ? true : current.map(String).includes(String(id)));
  return await new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:10000';
    const box = document.createElement('div'); box.className = 'card'; box.style.cssText = 'min-width:320px;max-width:92%;max-height:82vh;overflow:auto;margin:16px';
    const h = document.createElement('h3'); h.textContent = t('accounts_pick_title');
    const p = document.createElement('p'); p.className = 'muted'; p.style.margin = '4px 0 10px'; p.textContent = t('accounts_pick_sub');
    const list = document.createElement('div');
    list.innerHTML = groups.map((g) => `<label style="display:flex;align-items:center;gap:8px;padding:5px 2px"><input type="checkbox" value="${esc(String(g.id))}" ${checked(g.id) ? 'checked' : ''}><span>${esc(accLabel(g))}</span></label>`).join('');
    const quick = document.createElement('div'); quick.className = 'row'; quick.style.cssText = 'gap:8px;margin:6px 0';
    const bAll = document.createElement('button'); bAll.textContent = t('sel_all');
    const bNone = document.createElement('button'); bNone.textContent = t('sel_none');
    const setAll = (v) => list.querySelectorAll('input').forEach((c) => { c.checked = v; });
    bAll.onclick = () => setAll(true); bNone.onclick = () => setAll(false);
    quick.append(bAll, bNone);
    const row = document.createElement('div'); row.className = 'row'; row.style.cssText = 'margin-top:12px;gap:8px;justify-content:flex-end';
    const cancel = document.createElement('button'); cancel.textContent = t('cancel');
    const ok = document.createElement('button'); ok.className = 'primary'; ok.textContent = t('save');
    const done = (v) => { ov.remove(); resolve(v); };
    cancel.onclick = () => done(null);
    ok.onclick = () => done([...list.querySelectorAll('input:checked')].map((c) => c.value));
    ov.onclick = (e) => { if (e.target === ov) done(null); };
    row.append(cancel, ok); box.append(h, p, quick, list, row); ov.append(box); document.body.append(ov);
  });
}
