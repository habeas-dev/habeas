# Google Drive OAuth — "grant once, silent forever" (Chrome)

Habeas gets Drive access two ways (`extension/src/sinks/drive.js`):

- **Path A — `chrome.identity.getAuthToken` (Chrome, preferred).** Chrome holds a long-lived grant tied to
  the signed-in Google account and silently mints/refreshes access tokens **forever** after one consent —
  no 1-hour re-prompt. Active when `manifest.json` declares `oauth2` (a **"Chrome Extension"** OAuth client).
- **Path B — implicit flow via `launchWebAuthFlow` (fallback: when `oauth2` is absent, or a Firefox user who
  registered their own redirect).** Returns a 1 h access token (no refresh token); cached in `storage.local`
  with a silent `prompt=none` refresh. Occasionally still needs a reconnect.
- **Path C — device flow (RFC 8628) for Firefox (preferred there).** `oauth2.googleapis.com/device/code` →
  the user opens the shown verification page and enters a code → poll `.../token` → **access + refresh
  token**, all client-side. No redirect URI (so no per-install Firefox UUID to register), no server, and the
  refresh token renews silently forever. Uses a **"TVs and limited-input devices"** OAuth client; `drive.file`
  is on Google's device-flow allowed-scopes list. Active once `DEVICE_CLIENT_ID`/`DEVICE_CLIENT_SECRET` are
  set in `sinks/drive.js` (`preferDeviceFlow()` gates the Settings button); until then Firefox uses Path B.

Why Path B alone wasn't enough on Firefox: the `chromiumapp.org` / `*.extensions.allizom.org` redirect forces
a Google **"Web application"** client, whose token exchange **requires the client secret even with PKCE** — a
secret can't ship in a public extension, nor be proxied through habeas.dev without routing the Drive token
off-device (breaks local-first). The **device flow (Path C) sidesteps this**: its client type is
public/installed, so Google **distributes the client secret with the app by design** (RFC 8628 — it grants
nothing without a per-user in-browser consent), and it needs **no redirect at all**. So: Chrome → Path A;
Firefox → Path C (device flow); Path B remains a fallback.

### Path C setup (one-time)

1. In Google Cloud → the Habeas project (`246972215385`) → Credentials → **Create OAuth client ID** →
   application type **"TVs and Limited Input devices"**. Same consent screen / scope `drive.file`.
2. Put its client id + secret in `extension/src/sinks/drive.js` (`DEVICE_CLIENT_ID` / `DEVICE_CLIENT_SECRET`).
   The secret is **non-confidential for this client type** — committing it is per Google's model.
3. Ensure the OAuth app is **In production** so refresh tokens don't expire after 7 days.

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
