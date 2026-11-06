CREATE TABLE admin_password (
  owner_id INTEGER PRIMARY KEY CHECK (owner_id = 1) REFERENCES owners(id) ON DELETE CASCADE,
  revision TEXT NOT NULL UNIQUE,
  verifier TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions_next (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  credential_id TEXT REFERENCES passkeys(id),
  password_version TEXT,
  label TEXT NOT NULL,
  os TEXT NOT NULL,
  browser TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  recent_auth_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((credential_id IS NULL) <> (password_version IS NULL))
);

INSERT INTO sessions_next (
  id, token_hash, credential_id, label, os, browser, created_at,
  last_seen_at, expires_at, recent_auth_at, revoked_at
)
SELECT id, token_hash, credential_id, label, os, browser, created_at,
  last_seen_at, expires_at, recent_auth_at, revoked_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_next RENAME TO sessions;
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_credential ON sessions(credential_id);
CREATE INDEX sessions_password_version ON sessions(password_version);
