// Pure view computation for the popup inventory table. Filters by group/type and sorts by a column,
// returning `{ d, i }` rows where `i` is the item's ORIGINAL index in `items` — popup.js renders the
// checkbox as data-i="${i}" and onSend maps it back to inventory[i], so filtering/sorting must never
// lose that index. Sort is stable (ties keep source order). groupLabel(d) yields a row's group label.
export function inventoryView(items, opts = {}, groupLabel = () => '') {
  const { filterGroup = '', filterType = '', sortKey = 'date', sortDir = -1 } = opts;
  let view = items.map((d, i) => ({ d, i }));
  if (filterGroup) view = view.filter(({ d }) => groupLabel(d) === filterGroup);
  if (filterType) view = view.filter(({ d }) => String(d.type || '') === filterType);
  const keyOf = (d) => sortKey === 'group' ? groupLabel(d).toLowerCase()
    : sortKey === 'type' ? String(d.type || '').toLowerCase() : (d.date || '');
  return view.sort((A, B) => { const a = keyOf(A.d), b = keyOf(B.d); return a === b ? A.i - B.i : (a < b ? -1 : 1) * sortDir; });
}

// Sorted, unique, non-empty string values of `of(item)` across items (for the filter dropdowns).
export const distinctBy = (items, of) => [...new Set(items.map(of).filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
