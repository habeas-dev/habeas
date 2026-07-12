# Habeas

> *Habeas data* — making your right to your own data executable.

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/pbpehhngeidokhaokgloaneiibhceiog?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/pbpehhngeidokhaokgloaneiibhceiog)
[![Firefox Add-ons](https://img.shields.io/amo/v/habeas?label=Firefox%20Add-ons&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/firefox/addon/habeas/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

**Habeas** is an open-source, local-first runtime that lets you retrieve **your own data** from websites that offer no API, no bulk export, or intentionally make automation difficult.

It runs **inside your own authenticated browser session**, where you already have access to your data, and delivers that data wherever **you** choose.

Unlike server-side aggregators, Habeas never asks for your credentials, never logs in on your behalf, and never receives your personal data.

---

## Why Habeas exists

Many websites already contain your personal data:

- receipts
- invoices
- bank statements
- investment reports
- tax documents
- transaction history

In theory, that data belongs to you.

In practice, many providers make large-scale export difficult:

- no API;
- no email export;
- aggressive anti-bot protection;
- short document retention periods.

Habeas exists to bridge that gap.

It doesn't create new rights.

It simply makes existing ones practical.

---

# How it works

Habeas runs entirely inside your browser.

You authenticate yourself exactly as you normally would.

Once authenticated, Habeas can retrieve your own documents and structured data without ever sending your credentials to anyone else.

```
Websites (Sources)
        │
        ▼
      Habeas
  (local runtime)
        │
        ▼
Destinations (Sinks)

Folder • Downloads • Google Drive • HTTP • Your applications
```

Everything happens locally.

No remote login.

No credential vault.

No cloud scraper.

---

# Sources and Sinks

Habeas separates **where data comes from** from **where data goes**.

## Sources

A Source knows how to retrieve data from one specific website.

Examples include:

- supermarkets
- banks
- brokers
- online services

Each Source produces its own native outputs.

Depending on the service, those outputs may include:

- PDFs
- spreadsheets
- structured JSON
- images
- other provider-specific formats

Habeas deliberately does **not** convert or normalize these documents.

The provider's data remains exactly as produced.

---

## Sinks

A Sink decides where retrieved data goes.

Current sinks include:

- Downloads
- Local folders
- Google Drive
- HTTP endpoints

Applications can also integrate with Habeas to receive user-authorized data without implementing provider-specific authentication and extraction logic.

---

# One interface, native data

Habeas standardizes **access**, not **documents**.

Every Source may expose different outputs.

What remains consistent is the way Sources and Sinks communicate.

Applications integrate once with Habeas instead of once per provider.

---

# Growing the ecosystem

Sources are independent from the runtime.

Adding support for a new website does not require changing Habeas itself.

To make this scalable, Habeas includes a **session recorder** that helps infer new Source definitions from real browsing sessions.

The typical workflow is:

1. Perform the normal workflow on a website.
2. Record the session.
3. Review the inferred Source definition.
4. Refine it if necessary.
5. Optionally contribute it back to the community.

The goal is to make supporting new websites increasingly community-driven.

---

# Why local-first matters

The architecture is deliberate.

Unlike traditional aggregators:

- you log in yourself;
- MFA remains unchanged;
- credentials never leave your browser;
- Habeas operates no aggregation servers;
- your data goes only where you choose.

The browser is already trusted by the website.

Habeas simply runs there.

---

# Current status

**Working beta — published on both stores.**

Habeas is live on the [Chrome Web Store](https://chromewebstore.google.com/detail/pbpehhngeidokhaokgloaneiibhceiog)
and [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/habeas/).

The project already includes:

- a Manifest V3 extension;
- Chrome/Chromium support;
- Firefox support;
- multiple production-ready Sources;
- multiple Sinks (download / local folder / native Google Drive / HTTP);
- automatic synchronization on login;
- duplicate detection;
- a community Sources catalog with in-extension record mode, authoring, and sharing;
- multilingual interface (English + Spanish).

The architecture is stable, but the catalog of supported Sources continues to grow.

---

# Installation

## From your browser's store (recommended)

- **Chrome / Chromium** (Chrome, Edge, Brave, Opera…): [Chrome Web Store](https://chromewebstore.google.com/detail/pbpehhngeidokhaokgloaneiibhceiog)
- **Firefox** (128 or newer): [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/habeas/)

Prebuilt MV3 zips for each release are also attached to the [GitHub Releases](https://github.com/habeas-dev/habeas/releases).

## Development / unpacked build

Load the extension straight from the source tree while hacking on it:

**Chrome / Chromium**

1. Open `chrome://extensions`
2. Enable **Developer Mode**
3. Select **Load unpacked**
4. Choose the `extension/` directory

**Firefox**

1. Open `about:debugging`
2. Choose **This Firefox**
3. Select **Load Temporary Add-on**
4. Open `extension/manifest.json`

Or build the packaged zip yourself with `npm install && npm run package` (output in `dist/`).

---

# Contributing

There are many ways to contribute:

- create new Source definitions;
- improve existing Sources;
- develop new Sinks;
- improve documentation;
- report bugs;
- improve translations.

Contributions of all sizes are welcome.

---

# Legal

Habeas is designed to help users exercise their own data rights.

It operates entirely within the user's authenticated browser session.

It never stores credentials.

It never performs remote logins.

It never attempts to bypass authentication or MFA.

However, some websites may prohibit automated access in their Terms of Service, even when accessing your own account.

Using Habeas remains your own responsibility.

Nothing in this project constitutes legal advice.

---

# License

AGPL-3.0-or-later
