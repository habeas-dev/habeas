-- Habeas social service — D1 schema. Apply with:
--   wrangler d1 execute habeas-api --file=schema.sql   (add --remote to target production)

-- One rating per (source, client): a re-vote updates in place.
CREATE TABLE IF NOT EXISTS ratings (
  source_id  TEXT    NOT NULL,
  client     TEXT    NOT NULL,
  stars      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, client)
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id  TEXT    NOT NULL,
  author     TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  client     TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'visible',  -- moderation: visible | hidden | pending
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_source ON comments (source_id, status, created_at);

-- Append-only write log for per-client rate limiting.
CREATE TABLE IF NOT EXISTS writes (
  client     TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_writes_client ON writes (client, created_at);

-- Handoff collaboration workflow: a helper submits a REDACTED recording so the Habeas team can author a
-- source, with a two-way Q&A thread + attribution. `submitter` is the extension's pseudonymous id (no PII).
CREATE TABLE IF NOT EXISTS handoffs (
  id         TEXT    PRIMARY KEY,          -- crypto.randomUUID()
  domain     TEXT    NOT NULL,
  bundle     TEXT    NOT NULL,             -- the redacted recording JSON
  submitter  TEXT    NOT NULL,             -- pseudonymous extension id
  handle     TEXT    NOT NULL DEFAULT '',  -- optional display name to credit
  locale     TEXT    NOT NULL DEFAULT '',  -- submitter's browser locale → what language to reply in
  client     TEXT    NOT NULL,             -- rate-limit fingerprint
  status     TEXT    NOT NULL DEFAULT 'new', -- new | in_review | needs_info | authored | published | declined | superseded
  source_id  TEXT,                          -- the source once authored/published (attribution link)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_submitter ON handoffs (submitter, updated_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_updated ON handoffs (updated_at);

CREATE TABLE IF NOT EXISTS handoff_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  handoff_id TEXT    NOT NULL,
  sender     TEXT    NOT NULL,             -- 'team' | 'submitter'
  text       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hmsgs_handoff ON handoff_messages (handoff_id, created_at);
