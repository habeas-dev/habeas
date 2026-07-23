import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeIdOf, instancesOf, reconcileInstances, migrateBrandDomains } from '../src/lib/instances.js';

const amazon = { id: 'amazon', domains: ['amazon.es', 'amazon.com', 'amazon.de'] };

test('storeIdOf prefers the datasource id, falls back to the adapter', () => {
  assert.equal(storeIdOf({ id: 'amazon@amazon.com', adapter: 'amazon' }, amazon), 'amazon@amazon.com');
  assert.equal(storeIdOf({ id: 'amazon', adapter: 'amazon' }, amazon), 'amazon');
  assert.equal(storeIdOf(null, amazon), 'amazon');
  assert.equal(storeIdOf(undefined, undefined), '');
});

test('first chosen country keeps the bare adapter id; extras get adapter@domain', () => {
  const start = [{ id: 'other', adapter: 'dia' }, { id: 'amazon', adapter: 'amazon' }];
  const out = reconcileInstances(start, amazon, ['amazon.es', 'amazon.com']);
  const mine = instancesOf(out, 'amazon');
  assert.deepEqual(mine.map((d) => d.id), ['amazon', 'amazon@amazon.com']);
  assert.deepEqual(mine.map((d) => d.brandDomain), ['amazon.es', 'amazon.com']);
  assert.ok(out.find((d) => d.id === 'other'), 'other sources untouched');
});

test('re-saving the same set is stable (ids do not churn)', () => {
  const a = reconcileInstances([{ id: 'amazon', adapter: 'amazon' }], amazon, ['amazon.es', 'amazon.com']);
  const b = reconcileInstances(a, amazon, ['amazon.es', 'amazon.com']);
  assert.deepEqual(instancesOf(b, 'amazon').map((d) => d.id), ['amazon', 'amazon@amazon.com']);
});

test('dropping a country removes only its instance, keeps the kept one and its store id', () => {
  const two = reconcileInstances([{ id: 'amazon', adapter: 'amazon' }], amazon, ['amazon.es', 'amazon.com']);
  const one = reconcileInstances(two, amazon, ['amazon.es']);
  const mine = instancesOf(one, 'amazon');
  assert.deepEqual(mine.map((d) => d.id), ['amazon']);
  assert.equal(mine[0].brandDomain, 'amazon.es');
});

test('an existing @domain instance keeps its id even when it becomes the only country', () => {
  const two = reconcileInstances([{ id: 'amazon', adapter: 'amazon' }], amazon, ['amazon.es', 'amazon.com']);
  const only = reconcileInstances(two, amazon, ['amazon.com']); // drop es (the bare one), keep com (@domain)
  const mine = instancesOf(only, 'amazon');
  assert.deepEqual(mine.map((d) => d.id), ['amazon@amazon.com']); // store never moves
  assert.equal(mine[0].brandDomain, 'amazon.com');
});

test('kept instances preserve their extra config (account allow-list, schedule opts)', () => {
  const start = [{ id: 'amazon', adapter: 'amazon', brandDomain: 'amazon.es', groups: ['1', '2'] }];
  const out = reconcileInstances(start, amazon, ['amazon.es', 'amazon.de']);
  assert.deepEqual(instancesOf(out, 'amazon').find((d) => d.id === 'amazon').groups, ['1', '2']);
});

test('the bare primary keeps its config when it receives its first country', () => {
  const start = [{ id: 'amazon', adapter: 'amazon', groups: ['acct1'], options: { x: 1 } }]; // unpinned, has config
  const out = reconcileInstances(start, amazon, ['amazon.es', 'amazon.com']);
  const primary = instancesOf(out, 'amazon').find((d) => d.id === 'amazon');
  assert.equal(primary.brandDomain, 'amazon.es');
  assert.deepEqual(primary.groups, ['acct1'], 'account allow-list survives first pin');
  assert.deepEqual(primary.options, { x: 1 });
});

test('zero countries collapses to a single un-pinned bare instance', () => {
  const two = reconcileInstances([{ id: 'amazon', adapter: 'amazon' }], amazon, ['amazon.es', 'amazon.com']);
  const none = reconcileInstances(two, amazon, []);
  const mine = instancesOf(none, 'amazon');
  assert.deepEqual(mine.map((d) => d.id), ['amazon']);
  assert.equal(mine[0].brandDomain, undefined);
});

test('migrateBrandDomains fans a legacy brandDomains[] datasource into instances', () => {
  const cfg = { datasources: [{ id: 'amazon', adapter: 'amazon', brandDomains: ['amazon.es', 'amazon.com'] }] };
  const changed = migrateBrandDomains(cfg, { amazon });
  assert.equal(changed, true);
  assert.deepEqual(cfg.datasources.map((d) => d.id), ['amazon', 'amazon@amazon.com']);
  assert.ok(!('brandDomains' in cfg.datasources[0]), 'legacy field removed');
});

test('migrateBrandDomains is a no-op without the legacy field', () => {
  const cfg = { datasources: [{ id: 'amazon', adapter: 'amazon', brandDomain: 'amazon.es' }] };
  assert.equal(migrateBrandDomains(cfg, { amazon }), false);
});
