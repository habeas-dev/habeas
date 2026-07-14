// Full-tab viewer for a delivered document. Opened by the popup's Documents tab with ?sink=&src=&id=.
// It re-fetches the file itself (rather than receiving a blob: URL from the popup, which the popup would
// revoke on close) so PDFs/HTML/images render full-size and reliably. src = the source's base id
// (adapter.id); id = the item's internalId; sink = the delivery sink id it was retrieved from.
import { chrome } from '../lib/ext.js';
import { getConfig } from '../lib/config.js';
import { getAdapters } from '../adapters/index.js';
import { listSources, getSource } from '../lib/store.js';
import { getDocMeta } from '../lib/state.js';
import { retrieveDelivered } from '../lib/retrieve.js';

const qs = new URLSearchParams(location.search);
const sinkId = qs.get('sink'), base = qs.get('src'), id = qs.get('id');
const bar = document.getElementById('bar');
const mount = document.getElementById('mount');
const fail = (m) => { mount.innerHTML = ''; const p = document.createElement('p'); p.className = 'msg'; p.textContent = m; mount.appendChild(p); };

(async () => {
  try {
    const cfg = await getConfig();
    const sink = (cfg.sinks || []).find((s) => s.id === sinkId);
    const ADAPTERS = await getAdapters();
    const ds = cfg.datasources.find((d) => d.adapter === base) || cfg.datasources.find((d) => d.id === base);
    const adapter = (ds && ADAPTERS[ds.adapter]) || ADAPTERS[base] || null;
    if (!sink || !adapter) return fail('No se encontró el destino o la fuente en la configuración.');

    // Find the store key (base or base:stream) that holds this internalId, and take its record.
    let record = null;
    for (const key of await listSources()) {
      if (String(key).split(':')[0] !== base) continue;
      const src = await getSource(key).catch(() => null);
      if (src && src.items && src.items[id]) { record = src.items[id].record || {}; break; }
    }
    if (!record) return fail('No se encontró el registro en el almacén.');

    // Overlay the real date/amount learned at download time (docMeta), same as the popup.
    const known = (await getDocMeta(base).catch(() => ({})))[id];
    if (known) {
      if (known.date && !/^\d{4}-\d{2}-\d{2}/.test(record.date || '')) record = { ...record, date: known.date };
      if (typeof known.total === 'number' && record.total == null) record = { ...record, total: known.total };
    }

    const label = `${base} · ${(record.date || '').slice(0, 10)} · ${sink.id}`;
    bar.textContent = label + ' — cargando…';
    document.title = `${base} ${(record.date || '').slice(0, 10)}`;

    const res = await retrieveDelivered(sink, adapter, record);
    if (!res || !res.blob) {
      const tried = (res && res.tried && res.tried.length) ? '\n\nRutas probadas:\n' + res.tried.join('\n') : '';
      const hint = (res && res.reason) ? ' (' + res.reason + ')' : ' — si fue entregado por una versión antigua, prueba a re-descargarlo (toggle «Re-descargar del sitio») para regenerar la ruta.';
      return fail('No se pudo recuperar el fichero de este destino' + hint + tried);
    }
    const url = URL.createObjectURL(res.blob); // created in THIS tab → lives as long as the tab
    const f = document.createElement('iframe'); f.className = 'frame'; f.src = url;
    mount.innerHTML = ''; mount.appendChild(f);
    bar.textContent = label;
  } catch (e) { fail((e && e.message) || String(e)); }
})();
