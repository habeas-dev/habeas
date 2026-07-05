// DESIGN SKELETON (not API-verified) — Card movements, `transaction@1`, CURSOR pagination,
// NO PDF (metadata-only). Financial community source: allowed under the same-domain guard.
// CROSS-DOMAIN CASE: login is on examplebank.es but the API is api.examplebank.com — a legit
// multi-domain service. `crossDomainHosts` opts that host in; the extension will surface an
// explicit off-site-consent screen ("also sends your examplebank.es session to
// api.examplebank.com") and flag the source in the marketplace.
export default {
  id: 'examplebank-es',
  name: 'ExampleBank — card transactions',
  service: 'examplebank',
  trust: 'community',
  domain: 'examplebank.es',
  crossDomainHosts: ['api.examplebank.com'],
  categories: ['card', 'cash', 'transaction'],
  categorize: { field: 'operationType', map: { PURCHASE: 'card', WITHDRAWAL: 'cash' }, default: 'transaction' },
  match: ['https://particulares.examplebank.es/*'],
  auth: { tokenMatch: 'eyJ', replayHeaders: ['authorization', 'x-csrf-token'] },
  api: {
    host: 'https://api.examplebank.com',
    list: {
      path: '/v3/card-transactions',
      paging: 'cursor',
      itemsPath: 'transactions',
      nextPath: 'paging.nextCursor',
      cursorParam: 'cursor',
      params: { limit: 100 },
    },
  },
  fields: {
    internalId: 'id',
    date: 'valueDate',
    amount: 'amount',
    description: 'concept',
    counterparty: 'merchant.name',
    direction: 'direction',
    type: 'operationType',
    source: 'channel',
  },
  schema: 'transaction@1',
};
