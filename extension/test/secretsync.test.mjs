// Portable secrets vault: sink credentials encrypted under a user passphrase, stored (ciphertext only) in the
// canonical store, reused on another browser by entering the same passphrase. Stubs chrome.storage (local +
// session), an in-memory store backend, and an in-memory device key for secrets.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = {}, sess = {};
globalThis.chrome = { storage: {
  local: { get: async (k) => (typeof k === 'string' ? { [k]: mem[k] } : {}), set: async (o) => { Object.assign(mem, o); } },
  session: { get: async (k) => (typeof k === 'string' ? { [k]: sess[k] } : {}), set: async (o) => { Object.assign(sess, o); }, remove: async (k) => { delete sess[k]; } },
} };

const { setBackend } = await import('../src/lib/store.js');
const secrets = await import('../src/lib/secrets.js');
const { generateSecretKey } = await import('../src/lib/crypto.js');
const { enableVault, unlockVault, syncVaultIfUnlocked, lockVault, vaultStatus } = await import('../src/lib/secretsync.js');

let VAULT = null;
setBackend({ async getSecrets() { return VAULT; }, async putSecrets(b) { VAULT = b; return true; }, async listSources() { return []; }, async loadSource() { return null; }, async saveSource() {} });
// A stable in-memory device key (extractable so re-imports across the test share it — stands in for keystore.js).
const deviceKey = await generateSecretKey();
secrets._setKeyProvider(() => Promise.resolve(deviceKey));

// Simulate a SECOND browser: same shared store (VAULT kept) but no local secrets, no session key, no vault state.
const freshDevice = () => { delete mem['habeas:secrets']; delete mem['habeas:vault']; delete sess['habeas:vaultkey']; };

test('enable on device A, unlock on device B → credentials reused', async () => {
  await secrets.setSecret('cuentamo-token', 'PAIR-ABC-123');
  await secrets.setSecret('s3-secret', 'XYZ-KEY');
  assert.equal(await enableVault('correct horse battery'), true);
  const st = await vaultStatus();
  assert.ok(st.remote && st.enabled && st.unlocked, 'vault present, enabled, unlocked on A');

  freshDevice();
  assert.equal(await secrets.getSecret('cuentamo-token'), null, 'device B starts without the secret');
  const r = await unlockVault('correct horse battery');
  assert.deepEqual([r.ok, r.count], [true, 2]);
  assert.equal(await secrets.getSecret('cuentamo-token'), 'PAIR-ABC-123', 'imported on B');
  assert.equal(await secrets.getSecret('s3-secret'), 'XYZ-KEY');
});

test('a wrong passphrase fails cleanly and imports nothing', async () => {
  freshDevice();
  const r = await unlockVault('nope wrong words');
  assert.deepEqual([r.ok, r.reason], [false, 'bad-passphrase']);
  assert.equal(await secrets.getSecret('cuentamo-token'), null, 'no secret leaked in on a bad passphrase');
});

test('unlock with no remote vault → no-vault', async () => {
  const keep = VAULT; VAULT = null;
  assert.equal((await unlockVault('whatever')).reason, 'no-vault');
  VAULT = keep;
});

test('syncVaultIfUnlocked re-uploads a changed secret only while unlocked', async () => {
  freshDevice();
  assert.equal(await syncVaultIfUnlocked(), false, 'locked (no state/key) → no-op');
  await unlockVault('correct horse battery');           // now unlocked on this device
  await secrets.setSecret('new-sink', 'FRESH');
  assert.equal(await syncVaultIfUnlocked(), true, 'unlocked → re-encrypts + uploads');
  // the new secret is now in the vault: a third device can get it
  freshDevice();
  await unlockVault('correct horse battery');
  assert.equal(await secrets.getSecret('new-sink'), 'FRESH');

  await lockVault();
  assert.equal(await syncVaultIfUnlocked(), false, 'after lock → no-op again');
});
