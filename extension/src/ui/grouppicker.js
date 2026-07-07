// A selector for sources that expose groups (bank accounts, cards…). Before listing/delivering, the
// user picks WHICH group — or all. Returns the chosen groupId, or undefined for "all" / no groups.
import { listGroups } from '../runtime/inventory.js';
import { t } from '../lib/i18n.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const groupLabel = (g, i) => [g.name || g.alias, g.mask || g.cardMask || g.iban].filter(Boolean).join(' ').trim()
  || (t('group_n', [String(i + 1)]) + (g.id ? ' · …' + String(g.id).slice(-4) : ''));

export async function pickGroup(adapter, auth, net) {
  if (!(adapter.api && adapter.api.groups)) return undefined; // no groups → list everything (as before)
  let groups = [];
  try { groups = await listGroups(adapter, auth, net); } catch (e) { return undefined; }
  if (groups.length <= 1) return undefined; // 0/1 group → nothing to choose
  return await new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:10000';
    const box = document.createElement('div'); box.className = 'card'; box.style.cssText = 'min-width:300px;max-width:92%;margin:16px';
    const h = document.createElement('h3'); h.textContent = t('group_pick_title');
    const p = document.createElement('p'); p.className = 'muted'; p.style.margin = '4px 0 10px'; p.textContent = t('group_pick_sub');
    const sel = document.createElement('select'); sel.style.cssText = 'width:100%;padding:8px;font-size:14px';
    sel.innerHTML = `<option value="">${esc(t('group_all'))}</option>`
      + groups.map((g, i) => `<option value="${esc(g.id)}">${esc(groupLabel(g, i))}</option>`).join('');
    const row = document.createElement('div'); row.className = 'row'; row.style.cssText = 'margin-top:12px;gap:8px;justify-content:flex-end';
    const ok = document.createElement('button'); ok.className = 'primary'; ok.textContent = t('group_continue');
    const done = (v) => { ov.remove(); resolve(v); };
    ok.onclick = () => done(sel.value || undefined); // '' (All) → undefined → list all groups
    ov.onclick = (e) => { if (e.target === ov) done(undefined); };
    row.append(ok); box.append(h, p, sel, row); ov.append(box); document.body.append(ov);
  });
}
