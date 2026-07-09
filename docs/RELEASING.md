# Releasing Habeas

## Cadence
- **Every commit is pushed** to `main`.
- **Tag by milestone** (`vX.Y.Z`), not per patch bump. A tag triggers CI to build the MV3 zip, attach it
  to a GitHub **Release**, and (if configured) upload it to the **Chrome Web Store** as a draft.
- `extension/manifest.json` `version` must increase for every store submission (the CWS rejects a
  reused version). Bump it with each change (see the extension version convention).

## Cutting a milestone release
```bash
# main is green and pushed; manifest.json version is the one you want to ship
git tag v0.1.38
git push git@github.com:habeas-dev/habeas.git v0.1.38
```
CI (`.github/workflows/build.yml`) then: tests → lint → `web-ext build` → attaches `dist/habeas-*.zip`
to the Release → uploads the same zip to the Chrome Web Store **as a draft** (you press *Publish* in the
dashboard). To auto-submit for review instead, set `publish: true` on the CWS step.

## Chrome Web Store automation — one-time setup
The CWS upload step self-skips until these repo **Actions secrets** exist
(`Settings → Secrets and variables → Actions` on `habeas-dev/habeas`):

| Secret | Value |
| --- | --- |
| `CWS_EXTENSION_ID` | `pbpehhngeidokhaokgloaneiibhceiog` |
| `CWS_CLIENT_ID` | OAuth client id (below) |
| `CWS_CLIENT_SECRET` | OAuth client secret (below) |
| `CWS_REFRESH_TOKEN` | OAuth refresh token (below) |

### 1. Enable the API + make an OAuth client
1. In [Google Cloud Console](https://console.cloud.google.com/) pick (or create) a project.
2. **APIs & Services → Library →** enable **“Chrome Web Store API”**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID →** application type
   **Desktop app**. Note the **client id** and **client secret**.
4. On the **OAuth consent screen**, add your Google account as a **Test user** (so the token doesn't
   expire in 7 days while the app is in “testing”), or publish the consent screen.

### 2. Get a refresh token (once)
Authorize with scope `https://www.googleapis.com/auth/chromewebstore`:

```bash
# a) open this URL in a browser (replace CLIENT_ID), approve, copy the ?code=... from the redirect
https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&access_type=offline&prompt=consent&redirect_uri=urn:ietf:wg:oauth:2.0:oob&client_id=CLIENT_ID

# b) exchange the code for a refresh_token (fill CLIENT_ID, CLIENT_SECRET, CODE)
curl -s https://oauth2.googleapis.com/token \
  -d client_id=CLIENT_ID -d client_secret=CLIENT_SECRET \
  -d code=CODE -d grant_type=authorization_code \
  -d redirect_uri=urn:ietf:wg:oauth:2.0:oob
# → the JSON's "refresh_token" is CWS_REFRESH_TOKEN
```

> If `urn:ietf:wg:oauth:2.0:oob` is rejected, use the interactive helper
> `npx chrome-webstore-upload-keys` which walks the same flow and prints the refresh token.

### 3. Add the four secrets
Paste them into the repo's Actions secrets. Next `v*` tag → the zip uploads to the store as a draft.

## Google Drive OAuth redirect
The Drive sink uses `chrome.identity.launchWebAuthFlow`, whose redirect is
`https://<extension-id>.chromiumapp.org/`. For the published extension that is
**`https://pbpehhngeidokhaokgloaneiibhceiog.chromiumapp.org/`** — register it as an authorized redirect
URI on the Drive OAuth client (`246972215385-…apps.googleusercontent.com` in `sinks/drive.js`) or Drive
sign-in fails in the store build. Pin the manifest `key` if you want a locally-loaded unpacked build to
share the same id (and therefore the same redirect).
