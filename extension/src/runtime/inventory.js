// Adapter runtime: given an adapter + captured auth, enumerate all documents and
// fetch a document's PDF. Runs in an extension page (host_permissions grant the
// cross-origin fetch to pro.api.carrefour.es without CORS).

export async function listInventory(adapter, auth) {
  const a = adapter.api, f = adapter.fields;
  const now = new Date().toISOString();
  const from = new Date(Date.now() - windowMs(a.list.window)).toISOString();
  let offs = { ticketOffset: 0, atgfOffset: 0, atgnfOffset: 0, currentTickets: 0, currentAtgfOrders: 0, currentAtgnfOrders: 0 };
  const seen = new Set(), all = [];
  for (let g = 0; g < 100; g++) {
    const qs = new URLSearchParams({ from, to: now, count: a.list.params.count, ...offs });
    const res = await fetch(a.host + a.list.path + '?' + qs, { headers: auth });
    if (!res.ok) throw new Error('list ' + res.status);
    const data = await res.json();
    const items = data[a.list.itemsPath] || [];
    const fresh = items.filter((p) => !seen.has(p[f.externalId]));
    if (!fresh.length) break;
    fresh.forEach((p) => { seen.add(p[f.externalId]); all.push(mapDoc(f, p)); });
    offs = Object.assign(offs, data[a.list.offsetsPath] || {});
  }
  all.sort((x, y) => (x.date < y.date ? 1 : -1));
  return all;
}

export async function fetchPdf(adapter, auth, externalId) {
  const url = adapter.api.host + adapter.api.pdf.path.replace('{externalId}', encodeURIComponent(externalId));
  const res = await fetch(url, { headers: auth });
  if (!res.ok) throw new Error('pdf ' + res.status);
  return await res.blob();
}

function mapDoc(f, p) {
  return {
    externalId: p[f.externalId], date: p[f.date], total: p[f.total],
    storeName: p[f.storeName], storeAddress: p[f.storeAddress],
    type: p[f.type], source: p[f.source], _raw: p,
  };
}
function windowMs(w) {
  const m = /^(\d+)y$/.exec(w || '3y');
  return (m ? +m[1] : 3) * 365 * 24 * 3600 * 1000;
}
