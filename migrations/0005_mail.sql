CREATE TABLE mailboxes (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  verified_at INTEGER,
  code_hash TEXT,
  code_expires_at INTEGER,
  code_attempts INTEGER NOT NULL DEFAULT 0,
  last_code_at INTEGER,
  last_test_at INTEGER
);

CREATE TABLE mail_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  sender TEXT NOT NULL DEFAULT '',
  api_key_cipher TEXT,
  accept_requests INTEGER NOT NULL DEFAULT 0 CHECK (accept_requests IN (0,1)),
  primary_delivery_id TEXT REFERENCES mailboxes(id) ON DELETE SET NULL,
  notification_id TEXT REFERENCES mailboxes(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO mail_settings (id) VALUES (1);

CREATE TABLE invite_mailboxes (
  invite_id TEXT PRIMARY KEY REFERENCES invites(id) ON DELETE CASCADE,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE TABLE booking_mail_attempts (
  booking_id TEXT NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  channel TEXT NOT NULL,
  first_attempt_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY (booking_id,sequence,channel)
);
