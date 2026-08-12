import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRegion, rankSources } from '../../docs/source-rank.js';

// The landing showed a RANDOM sample of the catalogue. 14 of 24 published sources are Spain-only, so a
// visitor from anywhere else mostly saw supermarkets they cannot use — which matches what the analytics
// say: people arrive, read for about a minute, and not one has ever clicked through to a store.
// Everything here is read locally and never sent anywhere.

const SOURCES = [
  { id: 'carrefour-es', name: 'Carrefour', country: 'ES' },
  { id: 'dia-es', name: 'Dia', country: 'ES' },
  { id: 'ing-es', name: 'ING España', country: 'ES' },
  { id: 'amazon', name: 'Amazon', country: 'global' },
  { id: 'revolut', name: 'Revolut', country: 'global' },
  { id: 'n26', name: 'N26', country: 'EU' },
  { id: 'degiro', name: 'DeGiro', country: 'EU' },
  { id: 'paypal', name: 'PayPal' },                    // country not declared — global in practice
];
const idsOf = (list) => list.map((s) => s.id);

// ---------------------------------------------------------------- detectRegion

test('a full locale gives the country outright', () => {
  assert.deepEqual(detectRegion({ language: 'es-ES', timeZone: 'Europe/Madrid' }), { country: 'ES', inEurope: true });
  assert.deepEqual(detectRegion({ language: 'en-US', timeZone: 'America/New_York' }), { country: 'US', inEurope: false });
});

test('a bare language falls back to the time zone', () => {
  // "es" alone says nothing about WHERE: Spanish is spoken across the Americas.
  assert.equal(detectRegion({ language: 'es', timeZone: 'Europe/Madrid' }).country, 'ES');
  assert.equal(detectRegion({ language: 'es', timeZone: 'America/Mexico_City' }).country, 'MX');
  // …and a browser set to English in Spain is still someone in Spain.
  assert.equal(detectRegion({ language: 'en', timeZone: 'Europe/Madrid' }).country, 'ES');
});

test('Europe is recognised even when the exact country is not', () => {
  const r = detectRegion({ language: 'en', timeZone: 'Europe/Vilnius' });
  assert.equal(r.inEurope, true);
});

test('nothing detectable yields no country rather than a guess', () => {
  assert.deepEqual(detectRegion({}), { country: '', inEurope: false });
  assert.deepEqual(detectRegion(), { country: '', inEurope: false });
  assert.deepEqual(detectRegion({ language: 'xx', timeZone: 'Nowhere/Nothing' }), { country: '', inEurope: false });
});

// ---------------------------------------------------------------- rankSources

test('a visitor in Spain still sees Spanish sources first', () => {
  const top = idsOf(rankSources(SOURCES, { country: 'ES', inEurope: true })).slice(0, 3);
  assert.deepEqual(top, ['carrefour-es', 'dia-es', 'ing-es']);
});

test('a visitor in the US sees nothing Spain-only before the ones they can use', () => {
  const ranked = idsOf(rankSources(SOURCES, { country: 'US', inEurope: false }));
  const firstSpanish = ranked.findIndex((id) => id.endsWith('-es'));
  const lastUsable = Math.max(...['amazon', 'revolut', 'paypal'].map((id) => ranked.indexOf(id)));
  assert.ok(firstSpanish > lastUsable, `Spain-only sources should sit last: ${ranked.join(', ')}`);
});

test('a visitor elsewhere in Europe gets the EU sources above the Spain-only ones', () => {
  const ranked = idsOf(rankSources(SOURCES, { country: 'DE', inEurope: true }));
  assert.ok(ranked.indexOf('n26') < ranked.indexOf('carrefour-es'));
  assert.ok(ranked.indexOf('degiro') < ranked.indexOf('carrefour-es'));
});

test('an EU-only source is not promoted for someone outside Europe', () => {
  const ranked = idsOf(rankSources(SOURCES, { country: 'US', inEurope: false }));
  assert.ok(ranked.indexOf('amazon') < ranked.indexOf('n26'), 'a global source beats a European one in the US');
});

test('a source with no declared country is treated as global, not as an unknown', () => {
  const ranked = idsOf(rankSources(SOURCES, { country: 'US', inEurope: false }));
  assert.ok(ranked.indexOf('paypal') < ranked.indexOf('carrefour-es'));
});

test('an undetected region falls back to showing the international ones first', () => {
  const ranked = idsOf(rankSources(SOURCES, { country: '', inEurope: false }));
  assert.ok(ranked.indexOf('amazon') < ranked.indexOf('carrefour-es'));
});

test('ranking reorders and never drops, duplicates or invents a source', () => {
  const ranked = rankSources(SOURCES, { country: 'US', inEurope: false });
  assert.equal(ranked.length, SOURCES.length);
  assert.deepEqual(idsOf(ranked).slice().sort(), idsOf(SOURCES).slice().sort());
});

test('order within a tier is preserved, so the caller controls variety', () => {
  const shuffled = [SOURCES[4], SOURCES[3]]; // revolut, amazon — both global
  assert.deepEqual(idsOf(rankSources(shuffled, { country: 'US', inEurope: false })), ['revolut', 'amazon']);
});

test('an empty or missing catalogue is not an error', () => {
  assert.deepEqual(rankSources([], { country: 'ES' }), []);
  assert.deepEqual(rankSources(null, { country: 'ES' }), []);
});
