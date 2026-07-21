# Adding a source to Habeas — the three ways

A **source** in Habeas is a small piece of *declarative data* (a JSON/JS object, never code) that
teaches the extension how to read **your own** data out of one service: where its API lives, which
requests to replay, and how to turn the responses into normalized records and documents. Adding
support for a new service means writing one source definition — nothing else in Habeas changes.

There are three ways to do it, for three kinds of contributor. Pick the one that fits you.

| | 🔒 **Local only** | 🤝 **Assisted** | 🛠️ **Advanced (AI + proxy)** |
|---|---|---|---|
| **For** | Anyone | Anyone who wants to contribute back | Technical contributors |
| **Tools** | Just the extension | The extension | mitmproxy + any AI agent + this repo |
| **Leaves your machine?** | No — unless *you* later choose to share it | A **redacted** capture (you review it) | Nothing, unless you open a PR |
| **Result** | A private source only you use — **shareable later if you want** | The Habeas team authors & publishes it | You hand-author & submit a PR |
| **Effort** | Minutes, no code | Minutes, no code | An afternoon, some JSON |
| **Handles any service?** | Simple/medium | Simple/medium | **Any complexity** |

---

## 🔒 1. Local only — keep it to yourself

The extension has a built-in **record mode**. You browse the service and sign in as usual, Habeas
watches the session, infers a draft source, and lets you review it in a visual mapper. Save it and
it works **only for you** — the definition never leaves your machine, and neither does your data.

This is the private, zero-trust path: your source, your browser, your disk. And it's **not a dead
end** — if you later decide the source is worth sharing, the extension's **Share** button contributes
it (as a prefilled PR) at any time. Local-first by default, yours to publish if you choose.

> In the extension: **Settings → Create source → Record**. Follow the on-screen steps. See the
> assisted guide below for how the recorder/mapper works — the mechanics are the same; you just
> stop at "save locally" instead of "send to the team".

## 🤝 2. Assisted — let the team finish it

Same record mode, but at the end you **send the recording to the Habeas team**. Before anything
leaves your browser it is **redacted**: every value (amounts, ids, tokens, names) is replaced by a
type placeholder, keeping only the *shape* of the requests. You review exactly what will be sent.

The team then finishes and hardens the source, verifies it, and **publishes it to the community
catalogue** so everyone gets it — and credits you. You collaborate through a private thread right
inside the extension (the team can ask questions or request a short extra recording of one screen).

This is the best path for **non-technical contributors**: no code, no proxy, and the hard parts are
done for you. See **[docs/ASSISTED-AUTHORING.md](ASSISTED-AUTHORING.md)** for how the whole
pipeline works (record → infer → map → collaborate → publish).

## 🛠️ 3. Advanced — capture with a proxy and author with an AI

For technical contributors who want to build a source for **any service, no matter how complex**
(multi-account banks, cross-domain APIs, async document jobs, WebSocket feeds…): capture the
service's traffic yourself with **[mitmproxy](https://mitmproxy.org/)**, then work with **any AI
agent** (Claude Code, etc.) that can read your capture *and this repository* to hand-author the
source. Verify it **offline** against your capture with the bundled replay harness, then open a PR.

mitmproxy is **your** tool — you install and run it yourself; Habeas neither ships nor configures
it. The full walkthrough (mini install, capture, the complete adapter reference, templating, the
verification harness, and submission) is **[docs/AUTHORING-SOURCES.md](AUTHORING-SOURCES.md)**.

---

## Which produces a "published" source?

Paths **2** and **3** are the contribution paths — they put a source in the shared catalogue
(`habeas-dev/sources`). Path **1** keeps it private *by default*, but that's a choice, not a wall: a
local source can be **shared at any time** with the same Share button. All three produce the *same
kind* of definition — so a local source can later be contributed, and a captured one refined by hand.
Nothing is one-way.

## Ground rules (all paths)

- **Sources are DATA, not code.** No functions, no `eval`, no remotely-hosted JS (an MV3 rule and a
  security boundary). A source is a plain object the runtime interprets.
- **Same-registrable-domain trust boundary.** A source may only replay a captured session to the
  *same* eTLD+1 it was captured from. Touching another domain requires an explicit
  `crossDomainHosts` allowlist, which forces a prominent off-site consent screen.
- **Never commit a real capture.** Captures hold real personal data. Redact (assisted path) or keep
  them outside the repo (advanced path). Synthesize any test/example values from scratch.
- **Only real, API-verified sources ship.** Verify against a real capture before submitting.

See also: **[registry.md](registry.md)** (how the catalogue works), **[categories.md](categories.md)**
(the category list a source must use), and **[CONTRIBUTING.md](../CONTRIBUTING.md)**.
