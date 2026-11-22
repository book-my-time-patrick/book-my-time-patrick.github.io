CREATE TABLE admin_audit_log (
  id TEXT PRIMARY KEY,
  recorded_at INTEGER NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('POST','PATCH','PUT','DELETE')),
  route TEXT NOT NULL,
  auth_method TEXT NOT NULL CHECK(auth_method IN ('passkey','password'))
);
CREATE INDEX admin_audit_log_time ON admin_audit_log(recorded_at);
