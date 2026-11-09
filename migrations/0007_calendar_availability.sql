ALTER TABLE invites ADD COLUMN direct_enabled INTEGER NOT NULL DEFAULT 0 CHECK (direct_enabled IN (0, 1));
ALTER TABLE booking_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'request' CHECK (source IN ('request', 'direct'));

CREATE TABLE calendar_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  direct_enabled INTEGER NOT NULL DEFAULT 0 CHECK (direct_enabled IN (0, 1))
);
INSERT INTO calendar_settings (id) VALUES (1);

CREATE TABLE calendar_sources (
  provider TEXT PRIMARY KEY CHECK (provider IN ('icloud', 'outlook')),
  config_encrypted TEXT NOT NULL,
  revision TEXT NOT NULL,
  synced_at INTEGER,
  covered_from INTEGER,
  covered_until INTEGER,
  busy_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  sync_started_at INTEGER
);

CREATE TABLE calendar_connection_flows (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('authorize', 'exchange', 'select')),
  payload_encrypted TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
