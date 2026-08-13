import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { regionTier } from '../src/lib/region.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The marketplace's own ordering (update to install > installable > installed > incompatible) carries real
// meaning and must keep winning; regional relevance only breaks its ties. This checks the composition,
// which is the part that would be easy to get backwards.

const rank = (e) => e.rank;
const order = (entries, region) => entries.slice().sort((a, b) =>
  (rank(a) - rank(b)) || (regionTier(a, region) - regionTier(b, region)) || (a.name || a.id).localeCompare(b.name || b.id));

const ES = { country: 'ES', inEurope: true };
const US = { country: 'US', inEurope: false };

test('a source with an update still comes first, however irrelevant to this user', () => {
  const entries = [
    { id: 'amazon', name: 'Amazon', country: 'global', rank: 1 },
    { id: 'dia-es', name: 'Dia', country: 'ES', rank: 0 }, // has an update
  ];
  assert.deepEqual(order(entries, US).map((e) => e.id), ['dia-es', 'amazon']);
});

test('within the installable ones, the user’s own region wins over the alphabet', () => {
  const entries = [
    { id: 'aliexpress', name: 'AliExpress', country: 'global', rank: 1 },
    { id: 'bipdrive-es', name: 'Bip&Drive', country: 'ES', rank: 1 },
    { id: 'carrefour-es', name: 'Carrefour', country: 'ES', rank: 1 },
  ];
  // Alphabetically AliExpress would lead; in Spain the Spanish ones should.
  assert.deepEqual(order(entries, ES).map((e) => e.id), ['bipdrive-es', 'carrefour-es', 'aliexpress']);
  // …and outside Spain, the reverse.
  assert.equal(order(entries, US)[0].id, 'aliexpress');
});

test('name still breaks a tie when region says nothing', () => {
  const entries = [
    { id: 'revolut', name: 'Revolut', country: 'global', rank: 1 },
    { id: 'amazon', name: 'Amazon', country: 'global', rank: 1 },
  ];
  assert.deepEqual(order(entries, US).map((e) => e.id), ['amazon', 'revolut']);
});

test('the marketplace really wires this in, and reads the region locally', () => {
  const src = readFileSync(join(ROOT, 'src/ui/marketplace.js'), 'utf8');
  assert.match(src, /from '\.\.\/lib\/region\.js'/, 'must use the shared ranking, not its own copy');
  assert.match(src, /rank\(a\) - rank\(b\)\) \|\| \(regionTier/, 'state must still outrank regional relevance');
  assert.ok(!/fetch\([^)]*country|navigator\.geolocation/.test(src), 'the region must never be looked up over the network');
});
