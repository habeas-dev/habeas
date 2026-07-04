// DESIGN SKELETON (not API-verified) — Investment/pension movements, `investment@1`,
// NONE pagination, NO PDF. Demonstrates the investment schema (instrument, isin, units, price).
export default {
  id: 'examplebroker-es',
  name: 'ExampleBroker — portfolio movements',
  service: 'examplebroker',
  trust: 'community',
  domain: 'examplebroker.es',
  categories: ['fund', 'equity', 'pension', 'investment'],
  categorize: { field: 'assetClass', map: { FUND: 'fund', STOCK: 'equity', PENSION: 'pension' }, default: 'investment' },
  match: ['https://app.examplebroker.es/*'],
  auth: { tokenMatch: 'eyJ', replayHeaders: ['authorization'] },
  api: {
    host: 'https://app.examplebroker.es',
    list: {
      path: '/api/portfolio/movements',
      paging: 'none',
      itemsPath: 'movements',
    },
  },
  fields: {
    externalId: 'movementId',
    date: 'tradeDate',
    instrument: 'instrumentName',
    isin: 'isin',
    units: 'quantity',
    price: 'unitPrice',
    amount: 'grossAmount',
    operation: 'movementType',
    type: 'movementType',
  },
  schema: 'investment@1',
};
