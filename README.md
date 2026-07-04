# Habeas

> *Habeas data* — the right to your own data, made executable.

**Habeas** is an open-source browser extension that lets you extract **your own**
personal data — receipts, invoices, card and investment transactions — from
services that lock it behind non-automatable walls (Cloudflare, Akamai, …) and
offer neither an API nor an email export.

Unlike server-side aggregators, Habeas runs **inside your own browser session**:

- No anti-bot fight — it's your browser and your IP, already trusted.
- No stored credentials — you log in yourself.
- MFA/OTP handled by you, live.
- **Local-first** — your data goes only where *you* decide.

Per-service **adapters** are mostly declarative (data, not code), so they can be
audited and contributed by the community. Output is **normalized per domain**
(receipt, transaction, invoice, …) so any consumer can ingest it.

## Status

🚧 **Early design.** This is a placeholder release to reserve the package name.
The functional specification is being drafted. Follow along at
[habeas.dev](https://habeas.dev).

## License

[AGPL-3.0-or-later](./LICENSE).


## Legal & Privacy

> **Short version:** Habeas is a tool for exercising *your own* data rights. It runs entirely in your browser, under your own login, and never sends your data or credentials to us or anyone else. It is not a scraper-for-hire, and it is not legal advice.

### The premise: it's your data

In the EU/EEA, the GDPR already grants you a right of access to your personal data (Article 15) and a right to data portability — to receive your data "in a structured, commonly used and machine-readable format" (Article 20). Many services technically comply on paper while making bulk export practically impossible: no API, no email export, and a web interface guarded by anti-automation walls (Cloudflare, Akamai, and friends).

Habeas exists to close that gap. It doesn't grant you any right you don't already have; it just makes an existing right *executable*.

### Why the architecture matters legally

Habeas is deliberately designed to stay on the right side of the line that separates "a person accessing their own account" from "a third party accessing accounts on other people's behalf":

- **You log in yourself.** Habeas never sees, handles, or stores your credentials. There is no server-side login, no credential vault, no shared secret.
- **It runs in your own authenticated session.** The extraction happens in your browser, on your IP, after *you* have signed in and cleared any MFA/OTP challenge. There is no impersonation and no authentication bypass.
- **Local-first.** Extracted data goes only where you tell it to. The Habeas project operates no aggregation servers and never receives your data. You remain the sole controller of what you export.
- **You access only your own data.** Habeas is not a mechanism for reaching anyone else's account or records.

This is a materially different posture from server-side aggregators that store user credentials and log in remotely — the model that regulators and banks have spent years pushing the industry *away* from.

### The honest caveats

We would rather be straight with you than oversell the safety of this:

- **Terms of Service.** Many providers prohibit "automated access" to their services in their terms — sometimes even when it's your own account and your own session. Using Habeas may therefore breach a provider's terms. In the EU this is generally a *contractual* matter (in the worst case, a provider could restrict or close an account) rather than a criminal one, but the risk is real and it is yours to weigh. Habeas does not, and cannot, override a contract you agreed to.
- **This is not legal advice.** Data-protection law, and the rules on automated access, vary by country and change over time. The GDPR framing above applies to the EU/EEA. Elsewhere — for example under the US Computer Fraud and Abuse Act — the analysis can be very different. If anything here matters to you materially, consult a qualified lawyer in your jurisdiction.
- **You are responsible for what you extract.** Once data lands on your device, you are its controller. Storing financial or personal records securely — and deleting them when you no longer need them — is on you.

### What Habeas deliberately will not do

To keep that line bright, Habeas by design does **not**:

- store, transmit, or ask for your credentials;
- log in on your behalf from a server;
- bypass, defeat, or automate away authentication or MFA;
- access data belonging to anyone but the logged-in user;
- send your extracted data anywhere you did not explicitly choose.

If a proposed feature would cross any of these lines, it does not belong in Habeas.

