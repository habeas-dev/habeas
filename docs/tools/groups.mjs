// How the catalogue's raw categories roll up into the handful of groups a person actually browses by.
// Fifteen categories is a wall, not a filter bar. One mapping, shared by the guide index and the
// catalogue page: two different groupings of the same sources would be worse than either alone.
//
// `fuel` sits with tolls rather than with shops. It used to fall through to the default group, so a
// petrol-station receipt was filed under "Shops" — it is road spending, and that is where people look.
export const GROUPS = [
  { id: 'grocery', cats: ['grocery'], en: 'Supermarkets', es: 'Supermercados' },
  { id: 'retail',  cats: ['retail', 'home', 'diy', 'sports', 'marketplace'], en: 'Shops', es: 'Tiendas' },
  { id: 'banking', cats: ['banking', 'card', 'loan', 'investment'], en: 'Banks, cards & investments', es: 'Bancos, tarjetas e inversión' },
  { id: 'road',    cats: ['tolls', 'fuel'], en: 'Fuel, tolls & parking', es: 'Combustible, peajes y parking' },
  { id: 'utility', cats: ['energy', 'telecom', 'domains'], en: 'Services & subscriptions', es: 'Servicios y suscripciones' },
];

/** Every group a source belongs to. A source with several categories can appear under more than one. */
export const groupsOf = (categories = []) => GROUPS.filter((g) => categories.some((c) => g.cats.includes(c)));

/** The categories no group claims — surfaced rather than silently swept into a default. */
export const ungrouped = (categories = []) =>
  categories.filter((c) => !GROUPS.some((g) => g.cats.includes(c)));
