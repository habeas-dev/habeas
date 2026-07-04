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
