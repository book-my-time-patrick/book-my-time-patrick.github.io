CREATE TABLE booking_requests (
  id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL REFERENCES invites(id),
  submission_id TEXT NOT NULL,
  submission_fingerprint TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL CHECK (end_at > start_at),
  meeting_type TEXT NOT NULL CHECK (meeting_type IN ('online', 'in-person')),
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'declined', 'suggested', 'cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  mail_status TEXT NOT NULL DEFAULT 'pending' CHECK (mail_status IN ('pending', 'sent', 'failed', 'unconfigured')),
  UNIQUE (invite_id, submission_id)
);
CREATE INDEX booking_requests_status_start ON booking_requests(status, start_at);
CREATE INDEX booking_requests_updated ON booking_requests(updated_at);
CREATE INDEX booking_requests_confirmed_overlap ON booking_requests(start_at, end_at) WHERE status = 'confirmed';

CREATE TABLE booking_request_rates (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX booking_request_rates_expiry ON booking_request_rates(expires_at);
