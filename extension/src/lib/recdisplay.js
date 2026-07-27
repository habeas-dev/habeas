// Shared record-display helpers — the human NAME and the monetary AMOUNT of a stored record, used by every
// surface that lists documents (Archive, popup). Crucially they understand investment@2 broker records: a
// `trade`/`cash` record's product lives in `instrument` (a {name,ticker,isin} object) and its money is
// `netAmount`/`grossAmount`, not `total`/`amount` — so a trade shows the stock name + the sum invested/divested
// instead of a blank labelled by its category. Pure (no DOM / i18n) → unit-tested.

export const recName = (v) => (v && typeof v === 'object') ? (v.name || v.nombre || v.descripcion || '') : (v == null ? '' : String(v));

// The traded product: instrument name, else ticker/ISIN. Accepts an instrument object (investment@2) or a bare
// string (investment@1). '' for any non-investment record.
export function instrumentLabel(r) {
  const ins = r && r.instrument;
  if (!ins) return '';
  if (typeof ins === 'string') return ins;
  if (typeof ins !== 'object') return '';
  return recName(ins.name) || (ins.ticker ? String(ins.ticker) : '') || (ins.isin ? String(ins.isin) : '');
}

// The name to show for a record: the traded instrument first (investments), then the usual store/issuer/
// counterparty/description chain. '' when nothing is known (the caller may fall back to a category label).
export function displayName(r) {
  if (!r) return '';
  return instrumentLabel(r) || recName(r.store && r.store.name) || recName(r.storeName)
    || recName(r.issuer) || recName(r.counterparty) || recName(r.description) || '';
}

// The monetary amount to show: total/amount for most schemas, else an investment@2 settlement (netAmount, then
// grossAmount). null when there's no number to show.
export function displayAmount(r) {
  if (!r) return null;
  for (const k of ['total', 'amount', 'netAmount', 'grossAmount']) if (typeof r[k] === 'number') return r[k];
  return null;
}

export const isInvestmentRec = (r) => !!r && (r.recordType === 'trade' || r.recordType === 'cash');

// investment@2 side/kind → money direction ('in'/'out'), so a trade (which carries no `direction`) still gets a
// sign: buy/withdrawal/fee/tax/transfer_out = out (invested/paid); sell/dividend/interest/deposit/transfer_in = in.
export const SIDE_DIR = { buy: 'out', withdrawal: 'out', fee: 'out', tax: 'out', transfer_out: 'out', sell: 'in', dividend: 'in', interest: 'in', deposit: 'in', transfer_in: 'in' };
export const sideKey = (r) => String((r && (r.side ?? r.kind ?? r.operation ?? r.type)) ?? '').toLowerCase().replace(/[\s-]+/g, '_');
