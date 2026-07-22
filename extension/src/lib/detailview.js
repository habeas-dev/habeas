// Turn a stored JSON detail (the `data` artifact saved next to each document — e.g. an Amazon order's
// line items, payment method, refund) into a normalized, render-ready view: a list of line items + a set
// of known meta fields. Pure (no DOM / no i18n / no formatting) so it's unit-testable; the Archive drawer
// formats the result to HTML. The detail file is fetched on demand when a document is opened, so nothing has
// to be re-stored to surface the breakdown.
const META_KEYS = ['paymentMethod', 'paymentLast4', 'returnStatus', 'refundTotal'];

export function detailView(json) {
  const j = json && typeof json === 'object' ? json : {};
  const items = (Array.isArray(j.items) ? j.items : [])
    .map((it) => (it && typeof it === 'object' ? it : {}))
    .map((it) => ({
      name: String(it.title || it.name || it.asin || '').trim(),
      price: it.price != null && it.price !== '' ? it.price : null,
      returned: it.returned ? String(it.returned) : '',
    }))
    .filter((it) => it.name || it.price != null);
  const meta = {};
  for (const k of META_KEYS) if (j[k] != null && j[k] !== '') meta[k] = j[k];
  return { items, meta, currency: j.currency || null };
}

// True when there's anything worth rendering beyond the base record (line items or a known meta field).
export function hasDetail(view) {
  return !!view && (view.items.length > 0 || Object.keys(view.meta).length > 0);
}
