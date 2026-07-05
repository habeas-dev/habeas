import { t } from '../lib/i18n.js';
import { validateAdapter } from '../adapters/validate.js';

// Raw-JSON editor for a source: edit the whole definition (fix pagination, hosts, fields…),
// validated on save. Returns the parsed adapter, or null if cancelled. Used by Settings (edit a
// saved source) and the author flow (edit the draft before saving).
export function editJson(adapter) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999';
    const box = document.createElement('div'); box.className = 'card'; box.style.cssText = 'max-width:760px;width:92%;margin:16px';
    const h = document.createElement('h3'); h.textContent = t('edit_json_title', [adapter.id || '']);
    const ta = document.createElement('textarea'); ta.value = JSON.stringify(adapter, null, 2); ta.spellcheck = false;
    ta.style.cssText = 'width:100%;height:380px;font-family:ui-monospace,monospace;font-size:12px;white-space:pre';
    const status = document.createElement('div'); status.className = 'muted'; status.style.marginTop = '6px';
    const row = document.createElement('div'); row.className = 'row'; row.style.cssText = 'margin-top:10px;justify-content:flex-end;gap:8px';
    const cancel = document.createElement('button'); cancel.textContent = t('consent_cancel');
    const save = document.createElement('button'); save.className = 'primary'; save.textContent = t('json_save');
    row.append(cancel, save); box.append(h, ta, status, row); ov.append(box); document.body.append(ov);
    const done = (v) => { ov.remove(); resolve(v); };
    cancel.onclick = () => done(null);
    ov.onclick = (e) => { if (e.target === ov) done(null); };
    save.onclick = () => {
      let obj; try { obj = JSON.parse(ta.value); } catch (e) { status.textContent = t('json_badsyntax', [e.message]); return; }
      const v = validateAdapter(obj);
      if (!v.ok) { status.textContent = t('json_invalid', [v.errors.join('; ')]); return; }
      done(obj);
    };
  });
}
