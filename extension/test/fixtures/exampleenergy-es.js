// DESIGN SKELETON (not API-verified) — Utility/telco invoices, `invoice@1`, NONE pagination.
// Demonstrates: single-request list, invoice schema (issuer + number), PDF per invoice.
// api.host is a sibling subdomain of the login site → same eTLD+1, no cross-domain consent.
export default {
  id: 'exampleenergy-es',
  name: 'ExampleEnergy — invoices',
  service: 'exampleenergy',
  trust: 'community',
  domain: 'exampleenergy.es',
  categories: ['utility'],
  categorize: { field: 'supplyType', map: { ELECTRICITY: 'utility', GAS: 'utility', WATER: 'utility' }, default: 'utility' },
  match: ['https://oficina.exampleenergy.es/*'],
  auth: { tokenMatch: 'eyJ', replayHeaders: ['authorization'] },
  api: {
    host: 'https://oficina.exampleenergy.es',
    list: {
      path: '/api/invoices',
      paging: 'none',
      itemsPath: 'invoices',
    },
    pdf: { path: '/api/invoices/{internalId}/pdf' },
  },
  fields: {
    internalId: 'invoiceNumber',
    date: 'issueDate',
    total: 'amountDue',
    issuer: 'supplierName',
    issuerAddress: 'supplyAddress',
    number: 'invoiceNumber',
    type: 'invoiceType',
    source: 'channel',
  },
  schema: 'invoice@1',
};
