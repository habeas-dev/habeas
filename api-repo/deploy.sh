#!/usr/bin/env bash
# Deploy the Habeas API Worker (api.habeas.dev): tests → D1 schema migration → ADMIN_TOKEN secret → deploy.
# Run from anywhere; it cds into api-repo/. Needs an authenticated wrangler (`wrangler login`) with
# Workers + D1 write permissions. Idempotent: the schema uses CREATE ... IF NOT EXISTS; the secret is
# read from ~/.habeas-admin-token (generated once if absent) — that file is the team's key to read
# submissions and must NEVER be committed.
set -euo pipefail
cd "$(dirname "$0")"
WR="node_modules/.bin/wrangler"
TOKENFILE="$HOME/.habeas-admin-token"

echo "▶ tests"
npm test --silent

echo "▶ D1 schema migration (idempotent)"
"$WR" d1 execute habeas-api --file=schema.sql --remote
# Additive column migrations for tables that already exist on prod (CREATE ... IF NOT EXISTS won't alter
# them). SQLite has no ADD COLUMN IF NOT EXISTS, so ignore the "duplicate column" error on re-runs.
"$WR" d1 execute habeas-api --remote --command "ALTER TABLE handoff_messages ADD COLUMN source_json TEXT NOT NULL DEFAULT ''" 2>/dev/null || true

echo "▶ ADMIN_TOKEN secret"
if [ ! -s "$TOKENFILE" ]; then
  umask 077; openssl rand -hex 32 | tr -d '\n' > "$TOKENFILE"; chmod 600 "$TOKENFILE"
  echo "  generated a new ADMIN_TOKEN → $TOKENFILE"
fi
tr -d '\n' < "$TOKENFILE" | "$WR" secret put ADMIN_TOKEN

echo "▶ deploy"
"$WR" deploy

echo
echo "✓ Deployed. Read submissions with the team token (kept in $TOKENFILE):"
echo "    T=\$(cat $TOKENFILE)"
echo "    curl \"https://api.habeas.dev/handoff?token=\$T\""
