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
2. **Chrome-Extension OAuth client** — ✅ DONE. Created in Google Cloud (Item ID
   `pbpehhngeidokhaokgloaneiibhceiog`, scope `drive.file`). client id:
   `246972215385-1vvdh4kraid8dvksoa6gm41ctub746f8`.
3. **manifest `oauth2`** — ✅ DONE:
   ```json
   "oauth2": { "client_id": "246972215385-1vvdh4kraid8dvksoa6gm41ctub746f8.apps.googleusercontent.com", "scopes": ["https://www.googleapis.com/auth/drive.file"] }
   ```
   `permissions` already includes `identity`. **Path A is now LIVE on Chrome.**

401 handling: `getToken` uses Path A automatically; `withToken()` wraps every Drive op and on a 401 calls
`removeCachedToken(token)` + re-mints once (the throwing helpers surface `401`). Ensure the OAuth app is set
to **In production** so grants don't expire after 7 days.

## Multi-device sync — use native Drive, NOT a third-party folder syncer

The scope is `drive.file`: **per-file access to files this app created** (or the user opened via the Google
Picker). This is deliberate — it needs no CASA security assessment (see rule in `CLAUDE.md`). The consequence
is a hard boundary that trips people up:

- **Files another app put in Drive are invisible to Habeas.** A folder synced up by **Google Drive for
  Desktop**, **grive2**, **rclone**, Insync, or a manual upload was created by *that* app, not by Habeas's
  OAuth client → `drive.file` cannot see it. Verified empirically: even picking such a folder via the Google
  Picker does **not** grant access to the foreign files already inside it (the grant is per creating-app, not
  per folder). So the native Drive sink can't dedup against them and creates a **second same-named folder**
  (Drive allows duplicate folder names).
- **Native Drive IS the multi-device mechanism.** The Drive sink + `backend: drive` canonical store
  (`Habeas/_store/`) are written by Habeas itself. Because every device runs the **same OAuth client**, each
  device sees the same app-created store → cross-device dedup works with no external syncer. The extension
  merges records itself (by `internalId`), so no sync-conflict files.
- **The local-folder sink** is fine for a single machine (it dedups against its own local `manifest.json`, no
  Drive API involved) and can sit inside a synced/mounted folder (e.g. Drive Desktop's virtual drive) — but
  then cross-device dedup depends on that `manifest.json` syncing cleanly, which conflicts if two machines
  write concurrently.

**Recommendation:** for multi-device, use the **native Google Drive** store + sink and do **not** route Habeas
data through a third-party folder syncer. Surfaced in the UI as `dest_multidevice_hint` (Settings → Destinos).
