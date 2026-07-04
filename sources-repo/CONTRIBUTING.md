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
itemsPath}, fields.{externalId,date}, schema`. Pick `schema` from `receipt@1 | invoice@1 |
transaction@1 | investment@1`.

## Checklist

- [ ] `npm run validate` passes locally.
- [ ] Tested against your own account with the extension (record mode → Test).
- [ ] No secrets, tokens, or personal data in the JSON.
