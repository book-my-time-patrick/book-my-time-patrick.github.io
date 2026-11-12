CREATE TABLE activity_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  color TEXT NOT NULL CHECK(color IN ('blue','plum','green','amber')),
  duration INTEGER NOT NULL CHECK(duration IN (30,60,90,120)),
  location TEXT NOT NULL,
  capacity INTEGER CHECK(capacity BETWEEN 1 AND 100),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))
);

INSERT INTO activity_types(id,name,emoji,color,duration,location,capacity) VALUES
  ('coffee','Coffee chat','☕','amber',60,'',1),
  ('lunch','Lunch','🍽️','green',60,'',1),
  ('dinner','Dinner','🍜','plum',60,'',1),
  ('bar','Bar talk','🍸','plum',60,'',1),
  ('airport','Airport chat','✈️','blue',60,'',1),
  ('video','Video call','🎥','blue',60,'',1);

CREATE TABLE open_sessions (
  id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL REFERENCES activity_types(id),
  title TEXT NOT NULL,
  emoji TEXT NOT NULL,
  color TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL CHECK(end_at>start_at),
  location TEXT NOT NULL,
  description TEXT NOT NULL,
  map_url TEXT NOT NULL,
  capacity INTEGER CHECK(capacity BETWEEN 1 AND 100),
  approval_required INTEGER NOT NULL CHECK(approval_required IN (0,1)),
  email_required INTEGER NOT NULL CHECK(email_required IN (0,1)),
  invite_ids TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))
);
CREATE INDEX open_sessions_time ON open_sessions(start_at,end_at) WHERE archived=0;

ALTER TABLE invites ADD COLUMN preview_invite_id TEXT REFERENCES invites(id) ON DELETE SET NULL;
ALTER TABLE booking_requests ADD COLUMN open_session_id TEXT REFERENCES open_sessions(id);
CREATE INDEX booking_requests_open_session ON booking_requests(open_session_id,status) WHERE open_session_id IS NOT NULL;
