# Contributing a source

A source is a single JSON file, `sources/<id>.json`. The easiest way to create one is the
extension's **record mode** (Settings → *Create a source*): it watches your own session, drafts
the source, lets you test it, and its *Share* button opens a prefilled PR here.

## Rules (CI enforces these)

1. **Data, not code.** No functions, no `eval`, no remote scripts — MV3 forbids it and it is the
   core of the security model. Field transforms are declarative only.
2. **Same registrable domain.** Every host the source reads from or replays the session to must
   share one eTLD+1. If a service legitimately spans domains (e.g. login on `bank.es`, API on
   `bankapi.com`), list the extra ones in `crossDomainHosts` — **no wildcards**. This is allowed
   but marks the source as sending the session off-site (the extension asks the user to consent).
3. **`id` = `<service>-<country>`**, kebab-case, and the filename must be `<id>.json`.
4. **Least data.** Map only the fields the normalized schema needs.
5. **https** for `api.host` (http only for `localhost` dev sources — those aren't published here).

## Trust levels

- `community` (default) — contributed sources, shown with a *community* label.
- `first-party` — maintained and audited by the project. Community PRs are not merged as
  `first-party`; that label is set by maintainers after review.

Financial categories are **welcome** from the community under the same-domain guard.

## Fields

See `schema/adapter.schema.json` and the reference sources in `sources/`. Minimum:
`id, name, service, domain, categories, match, auth.replayHeaders, api.host, api.list.{path,
itemsPath}, fields.{internalId,date}, schema`. Pick `schema` from `receipt@1 | invoice@1 |
transaction@1 | investment@1`.

## `changelog` — one entry per published version

Bumping `version` without adding an entry is refused by CI. A version identifies one
*behaviour* permanently, so the entry is the only place a reader can find out what changed.

You do **not** need a bump to fix the wording of a note, the guide copy, the brand or the
attribution. Those are served from `index.json`, so a correction reaches the website and the
marketplace immediately, and bumping for a sentence would offer every user a pointless update.
Change the definition and you must bump: CI publishes a hash of everything except those
presentational fields and refuses a same-version republish whose hash moved.

Write it **for the person installing the source**, not for whoever made the change: one or
two plain sentences on what is different for them, and whether they need to do anything.
Leave out sample sizes, record counts, field names and internal reasoning — the note is
rendered on the source's public page and in the extension's marketplace, where the reader is
deciding whether an update affects them. Verification detail belongs in the commit message.

Key `changes` by language (`{"en": "...", "es": "..."}`); a plain string is served to every
language regardless of what it is written in.

## `content` — the guide page on habeas.dev (optional)

A source may carry `content`, one entry per language code, and habeas.dev generates a guide page
from it — `/download/<slug>.html` in English, `/es/descargar/<slug>.html` in Spanish, cross-linked.
Publishing the source publishes the page; there is nothing to do on the website side.

```json
"brand": "Carrefour",
"content": {
  "en": { "slug": "carrefour-receipts", "docs": "purchase receipts",
          "h1": "How to download your Carrefour receipts",
          "intro": "One or two sentences on why this service's documents are hard to keep.",
          "note": "Optional caveat, specific and verifiable." },
  "es": { "slug": "tickets-carrefour", "docs": "tickets de compra",
          "h1": "Cómo descargar tus tickets de Carrefour",
          "intro": "…" }
}
```

**What you write here gets published and indexed under habeas.dev.** That makes it different from the
rest of the file, and it is reviewed as such:

- **Only what is verifiable.** Describe what the documents are and what the source extracts. Do NOT
  write step-by-step instructions for the service's own interface unless you have checked them —
  they go stale and they are what turns a useful page into a wrong one.
- **State the limits.** If the service drops old PDFs, or a whole product is out of reach, say so in
  `note` or `gaps`. A page that oversells is worse than no page.
- **No marketing, no keyword stuffing, no outbound links.** The page carries the domain's reputation,
  not just your source's.
- **Both languages or neither** is preferred; a language with no entry simply gets no page, which
  leaves that half of the site linking nowhere.

Sources flagged `beta: true` never get a page, whatever `content` says: the extraction is not
verified against a real capture yet, and a page ranking for "how to download your X" when X may not
work does more harm than good.

## Licence, and what a source must never contain

By opening a PR here you place your source under the catalogue's terms
([`sources/LICENSE`](./sources/LICENSE)): the **definition** goes into the public domain under
**CC0-1.0**, and the **`content`** prose is **CC-BY-4.0**. None of it is AGPL. A definition is
closer to a fact than to a program, and it does more good unencumbered.

You also confirm that:

- **you wrote it**, or derived it by observing a service you were entitled to use;
- **it contains no personal data** — no real names, addresses, account or card numbers, amounts,
  document ids, or captured sample responses; and
- **it contains no credentials** — no tokens, cookies, keys or session material in any field,
  examples included.

Those last two matter more here than in most projects, because a source is authored from a capture
of a real account. Keep the capture outside the repository and let nothing from it reach the JSON:
invent example values rather than trimming real ones.

## Checklist

- [ ] `npm run validate` passes locally.
- [ ] Tested against your own account with the extension (record mode → Test).
- [ ] If you added `content`: every claim is verifiable, limits are stated, and both languages are present.
- [ ] No secrets, tokens, personal data, or any value copied from a real capture in the JSON.
