CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_opened_at INTEGER,
  open_count INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK(kind IN ('invite','preview')),
  creator_session_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_kind_created ON invites(kind,created_at DESC);
CREATE INDEX IF NOT EXISTS invites_expiry ON invites(expires_at);
