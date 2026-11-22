CREATE TABLE booking_rule_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  rules_json TEXT NOT NULL CHECK(json_valid(rules_json)),
  revision TEXT NOT NULL
);
INSERT INTO booking_rule_settings VALUES(1,'{}','initial');
ALTER TABLE invites ADD COLUMN booking_rules_json TEXT CHECK(booking_rules_json IS NULL OR json_valid(booking_rules_json));
CREATE INDEX booking_ordinary_confirmed ON booking_requests(start_at) WHERE status='confirmed' AND open_session_id IS NULL;
ALTER TABLE booking_requests ADD COLUMN buffer_before_ms INTEGER NOT NULL DEFAULT 0 CHECK(buffer_before_ms BETWEEN 0 AND 7200000);
ALTER TABLE booking_requests ADD COLUMN buffer_after_ms INTEGER NOT NULL DEFAULT 0 CHECK(buffer_after_ms BETWEEN 0 AND 7200000);
