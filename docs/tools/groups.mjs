// How the catalogue's raw categories roll up into the handful of groups a person actually browses by.
// Fifteen categories is a wall, not a filter bar. One mapping, shared by the guide index and the
// catalogue page: two different groupings of the same sources would be worse than either alone.
//
// `fuel` sits with tolls rather than with shops. It used to fall through to the default group, so a
// petrol-station receipt was filed under "Shops" — it is road spending, and that is where people look.
// The icon and colour describe the KIND of document, never the company. A mark that evokes a particular
// brand — even deliberately not the official one — is a similar sign rather than a reference to theirs,
// which is the infringement case, and it forfeits the referential-use defence that quoting the real mark
// would have had. Five generic icons also stay consistent across a catalogue that keeps growing.
export const GROUPS = [
  { id: 'grocery', cats: ['grocery'], icon: '🛒', tint: '#2a7d6d', en: 'Supermarkets', es: 'Supermercados' },
  { id: 'retail',  cats: ['retail', 'home', 'diy', 'sports', 'marketplace'], icon: '🛍️', tint: '#c9752b', en: 'Shops', es: 'Tiendas' },
  { id: 'banking', cats: ['banking', 'card', 'loan', 'investment'], icon: '🏦', tint: '#3b5b8c', en: 'Banks, cards & investments', es: 'Bancos, tarjetas e inversión' },
  { id: 'road',    cats: ['tolls', 'fuel'], icon: '⛽', tint: '#8c5a3b', en: 'Fuel, tolls & parking', es: 'Combustible, peajes y parking' },
  { id: 'utility', cats: ['energy', 'telecom', 'domains'], icon: '💡', tint: '#6b4f8c', en: 'Services & subscriptions', es: 'Servicios y suscripciones' },
];

/** Every group a source belongs to. A source with several categories can appear under more than one. */
export const groupsOf = (categories = []) => GROUPS.filter((g) => categories.some((c) => g.cats.includes(c)));

/** The categories no group claims — surfaced rather than silently swept into a default. */
export const ungrouped = (categories = []) =>
  categories.filter((c) => !GROUPS.some((g) => g.cats.includes(c)));
