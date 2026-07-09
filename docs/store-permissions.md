# Chrome Web Store — permission justifications

Paste these into the CWS Developer Dashboard → **Privacy practices** tab. They describe exactly how
Habeas uses each permission (all local, in the user's own session; nothing sent to third parties).

## Single purpose
Habeas lets a user extract **their own** personal data (receipts, invoices, orders, card/investment
statements) from services they are logged into, and save it where they choose (download, a local
folder, their own Google Drive, or an endpoint they configure). Everything runs in the user's already
authenticated browser session; Habeas stores no credentials and sends nothing to any Habeas server.

## cookies  *(flagged — required)*
The `cookies` permission is used **only to clear a website's own cookies** for the site the user is
currently extracting data from. Some services corrupt their own session cookies, which breaks their
login page (e.g. a 400/500 error on sign-in). When the user starts a sync and the session is invalid,
Habeas removes the corrupted cookies **for that site's domain only** so the user can log in cleanly and
retry. Habeas never reads, stores, or transmits cookie values, and never touches cookies for any site
other than the source the user is actively using.

## webRequest  *(flagged — required)*
The `webRequest` permission is used in **observation-only (non-blocking) mode** to capture the user's
**own** session authorization for the site they are extracting data from. Some sites' single-page apps
send their API token before Habeas's in-page script is ready; `webRequest` lets Habeas read the
`Authorization` header (and the request URL, to pick up an account identifier the site puts there) from
requests **the site itself makes to its own API**, so Habeas can replay them to the **same** site's API
to download the user's data. It observes only requests to the enabled source's own API host(s), reads
only the `Authorization` header and the URL (never response bodies, never other sites' traffic), and
keeps the token **in memory only** (`storage.session`, cleared when the browser closes). Nothing is
sent to any third party.

## storage
Stores the user's configuration (which sources/sinks they set up) and a local delivery ledger (which
documents were already saved, to avoid duplicates) in `storage.local`. Captured session tokens are kept
in `storage.session` (memory only, cleared on browser close) and never written to disk.

## downloads
Saves the documents the user chose to export (the "download" sink packages them into a single ZIP that
downloads to the user's computer).

## identity
Used only for the optional **Google Drive** sink: `chrome.identity.launchWebAuthFlow` runs Google's
OAuth so the user can save their own data to their own Google Drive (scope `drive.file` — only files
this app creates). No other identity/profile data is accessed.

## notifications
Shows a notification when an automatic sync finishes (e.g. "3 new receipts saved"), so the user knows a
background sync ran without opening the popup.

## scripting
Injects Habeas's in-session capture content scripts on the **enabled source's own site** so they can
read the user's auth as the user browses/logs in (and support record mode for authoring a source). Only
runs on sites the user has explicitly enabled a source for.

## declarativeNetRequestWithHostAccess
Sets the `Referer` header on the API/PDF requests that some sources gate behind their own page (a
page/extension `fetch` cannot set `Referer`). Used only for the enabled source's own requests.

## host permissions (`optional_host_permissions: https://*/*`)
Requested **per site, on demand**: Habeas accesses a website only after the user explicitly enables a
source for that site (and accepts a consent screen for cross-domain sources). The broad optional pattern
exists so users can add community sources for any service they personally use, without shipping a fixed
allowlist. Habeas never accesses a site the user hasn't enabled.

## Data usage disclosures (checkboxes)
- Does the extension collect/transmit personal data off the user's device? **No** — data stays on the
  device unless the user configures a sink they own (their Google Drive, a local folder, or their own
  HTTP endpoint). Habeas operates no server that receives user data.
- Is data sold to third parties? **No.**
- Is data used for purposes unrelated to the single purpose? **No.**
