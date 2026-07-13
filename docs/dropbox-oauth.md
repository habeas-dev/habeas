# Dropbox OAuth setup (maintainer)

Habeas ships its own **public** Dropbox app (PKCE, no client secret — the app key is publishable). Users
connect from Settings → the Dropbox sink → **Connect Dropbox** (a tab-based flow that works on Chrome and
Firefox, reading the `?code` off the static bounce page `https://habeas.dev/oauth/dropbox.html`). No per-user
registration is needed.

## Required app permissions (scopes)

In the [Dropbox App Console](https://www.dropbox.com/developers/apps) → the Habeas app → **Permissions** tab,
enable **all** of these, then **Submit**:

| Scope | Used for | Symptom if missing |
| --- | --- | --- |
| `files.metadata.read` | list the store / manifest folder (`files/list_folder`) | can't see existing sources |
| `files.content.write` | upload documents + manifests (`files/upload`) | delivery fails |
| `files.content.read` | read back the cumulative manifest **and** the canonical store on Dropbox (`files/download`) | `401 … app not permitted to access this endpoint` on download; the store browser can list a source but not load it; each delivery silently rewrote only its own batch into the manifest |

The extension requests exactly these in the authorize URL (`scope=files.metadata.read files.content.write
files.content.read`, `sinks/dropbox.js`). The scopes must **also** be enabled on the app itself — the
authorize screen can only grant what the app is configured for.

## After changing scopes: users must reconnect

A Dropbox **refresh token carries the scopes granted at authorization time**. Adding a scope in the console
does **not** upgrade tokens minted earlier. Every user (including you) must **reconnect** the Dropbox sink
(Settings → Dropbox sink → **Connect Dropbox**) to mint a new refresh token that includes the new scope.

## App type

The shipped app is an **App folder** type, so everything is scoped under `Aplicaciones/<app>/` automatically —
the sink's default root folder is therefore **empty** (adding another `Habeas/` would nest redundantly).
