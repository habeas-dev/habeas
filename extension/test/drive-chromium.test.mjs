// Chromium browsers that are not Chrome (Edge, Brave, Opera, Vivaldi) expose chrome.identity.getAuthToken
// but it never yields a token — it is tied to being signed into Chrome itself. getToken already falls
// through to Path B when Path A fails, so sending to Drive works there; this covers the reporting side,
// which used to answer "not connected" without ever looking at the Path B token it was about to use.
const store = {};
globalThis.chrome = {
  storage: { local: {
    get: async (k) => (k in store ? { [k]: store[k] } : {}),
    set: async (o) => Object.assign(store, o),
    remove: async (k) => { delete store[k]; },
  } },
  runtime: {
    lastError: null,
    getManifest: () => ({ oauth2: { client_id: 'chrome-only.apps.googleusercontent.com' } }),
  },
  // Present, as on Edge/Brave/Opera — and always failing, as on Edge/Brave/Opera.
  identity: {
    getAuthToken: (_opts, cb) => {
      globalThis.chrome.runtime.lastError = { message: 'OAuth2 not supported' };
      cb(undefined);
      globalThis.chrome.runtime.lastError = null;
    },
  },
};

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { driveConnected } = await import('../src/sinks/drive.js');

test('a Path B token counts as connected even where getAuthToken exists but never works', async () => {
  store['gdrive:test'] = { token: 'ya29.synthetic', expiresAt: Date.now() + 3600e3 };
  assert.equal(await driveConnected('test'), true,
    'Drive would send fine via Path B, so Settings must not report it as disconnected');
});

test('with no Path B token either, it is genuinely not connected', async () => {
  delete store['gdrive:test'];
  assert.equal(await driveConnected('test'), false);
});

test('an expired Path B token is not connected', async () => {
  store['gdrive:test'] = { token: 'ya29.synthetic', expiresAt: Date.now() - 1000 };
  assert.equal(await driveConnected('test'), false);
});
