# Google Drive OAuth — "grant once, silent forever" (Chrome)

Habeas gets Drive access two ways (`extension/src/sinks/drive.js`):

- **Path A — `chrome.identity.getAuthToken` (Chrome, preferred).** Chrome holds a long-lived grant tied to
  the signed-in Google account and silently mints/refreshes access tokens **forever** after one consent —
  no 1-hour re-prompt. Active when `manifest.json` declares `oauth2` (a **"Chrome Extension"** OAuth client).
- **Path B — implicit flow via `launchWebAuthFlow` (fallback: Firefox, or when `oauth2` is absent).** Returns
  a 1 h access token (no refresh token); cached in `storage.local` with a silent `prompt=none` refresh.
  Occasionally still needs a reconnect. This is the current default until Path A is configured.

Why not a cross-browser refresh token without a server: the `chromiumapp.org` redirect forces a Google
**"Web application"** client, whose token exchange **requires the client secret even with PKCE** — and a
secret can't ship in a public extension, nor be proxied through habeas.dev without routing the user's Drive
refresh token off-device (breaks local-first). So Path A is Chrome-only; Firefox stays on Path B.

## One-time setup to enable Path A

1. **Pin the extension ID** — ✅ DONE. `manifest.json` now carries the `"key"` extracted from the published
   `.crx`'s identity RSA proof, so the **unpacked dev build loads as `pbpehhngeidokhaokgloaneiibhceiog`**
   (same as the Web Store item → one OAuth client covers both). CWS ignores `key` on upload.
2. **Google Cloud console → APIs & Services → Credentials → Create OAuth client ID → type "Chrome
   Extension"**, Application/Item ID = `pbpehhngeidokhaokgloaneiibhceiog`. Scope:
   `https://www.googleapis.com/auth/drive.file` (non-sensitive → no CASA). Set the app to **In production**
   so tokens/grants don't expire after 7 days.
3. Add to `manifest.json`:
   ```json
   "oauth2": { "client_id": "<the new Chrome-Extension client id>", "scopes": ["https://www.googleapis.com/auth/drive.file"] }
   ```
   `permissions` already includes `identity`.

Once `oauth2.client_id` is present, `getToken()` uses Path A automatically. On a 401 from Drive, call the
exported `removeCachedToken(token)` and retry so Chrome re-mints instead of returning a stale token (wire
this into the Drive fetch helpers when activating).
