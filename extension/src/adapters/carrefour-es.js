// Carrefour España — tickets. Adapter as data (mirrors adapters/carrefour-es.yaml).
// Validated end-to-end: pro.api.carrefour.es (APIgee, not behind Cloudflare), auth is
// the user JWT (eyJ...) + CSRF/origin headers.
export default {
  id: 'carrefour-es',
  name: 'Carrefour España — tickets',
  service: 'carrefour',
  // Trust tier + registrable domain. All hosts this source touches share this eTLD+1, so it
  // satisfies the same-domain security guard without a cross-domain exception.
  trust: 'first-party',
  domain: 'carrefour.es',
  country: 'ES',
  // Categories this source can emit (for sink compatibility) + how to categorize each doc.
  categories: ['grocery', 'fuel', 'retail'],
  categorize: {
    field: 'purchaseType',
    map: { HYPERMARKET: 'grocery', SUPERMARKET: 'grocery', REFUELING: 'fuel' },
    default: 'retail',
  },
  match: ['https://www.carrefour.es/*'],
  auth: {
    tokenMatch: 'eyJ',
    replayHeaders: ['authorization', 'x-xsrf-token', 'x-csrf-token', 'requestorigin', 'sessionid'],
  },
  api: {
    host: 'https://pro.api.carrefour.es',
    list: {
      path: '/md-purchasesAccount-v1/purchases',
      paging: 'offsets',
      itemsPath: 'purchases',
      offsetsPath: 'offsets',
      // Multi-offset pagination seed (tickets + online orders); merged with the returned offsets.
      initialOffsets: { ticketOffset: 0, atgfOffset: 0, atgnfOffset: 0, currentTickets: 0, currentAtgfOrders: 0, currentAtgnfOrders: 0 },
      range: { from: 'from', to: 'to' },
      window: '3y',
      params: { count: 50 },
    },
    pdf: { path: '/md-ticketsAccount-v1/tickets/{internalId}/pdf' },
  },
  fields: {
    internalId: 'purchaseId',
    date: 'purchaseDate',
    total: 'amount',
    storeName: 'mallName',
    storeAddress: 'mallAddress',
    type: 'purchaseType',
    source: 'orderSource',
  },
  schema: 'receipt@1',
};
