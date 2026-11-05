PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS owners (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  webauthn_user_id TEXT NOT NULL UNIQUE,
  totp_cipher TEXT NOT NULL,
  totp_last_step INTEGER NOT NULL DEFAULT -1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL,
  name TEXT NOT NULL,
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  credential_id TEXT NOT NULL REFERENCES passkeys(id),
  label TEXT NOT NULL,
  os TEXT NOT NULL,
  browser TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  recent_auth_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS sessions_credential ON sessions(credential_id);
CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('setup', 'login', 'reauth', 'register')),
  challenge TEXT NOT NULL,
  session_id TEXT,
  payload TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_challenges_expiry ON auth_challenges(expires_at);
CREATE TABLE IF NOT EXISTS auth_rates (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rates_expiry ON auth_rates(expires_at);
