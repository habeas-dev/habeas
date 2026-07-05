// DESIGN SKELETON (not API-verified) — Retail receipts, `receipt@1`, PAGE pagination.
// Demonstrates: page paging, dotted itemsPath, PDF per document. Hosts share one eTLD+1.
export default {
  id: 'examplemart-es',
  name: 'ExampleMart España — receipts',
  service: 'examplemart',
  trust: 'community',
  domain: 'examplemart.es',
  categories: ['grocery', 'retail'],
  categorize: { field: 'channel', map: { STORE: 'grocery', ONLINE: 'retail' }, default: 'retail' },
  match: ['https://www.examplemart.es/*'],
  auth: { tokenMatch: 'eyJ', replayHeaders: ['authorization', 'x-csrf-token'] },
  api: {
    host: 'https://api.examplemart.es',
    list: {
      path: '/v1/receipts',
      paging: 'page',
      itemsPath: 'data.items',
      pageParam: 'page',
      pageStart: 1,
      params: { count: 50 },
    },
    pdf: { path: '/v1/receipts/{internalId}/pdf' },
  },
  fields: {
    internalId: 'id',
    date: 'purchasedAt',
    total: 'amount',
    storeName: 'store.name',
    storeAddress: 'store.address',
    type: 'channel',
    source: 'channel',
  },
  schema: 'receipt@1',
};
