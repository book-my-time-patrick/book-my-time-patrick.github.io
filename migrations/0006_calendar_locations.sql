CREATE TABLE calendar_location_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_city TEXT NOT NULL DEFAULT '' CHECK (length(default_city) <= 24)
);
INSERT INTO calendar_location_settings (id) VALUES (1);

CREATE TABLE calendar_location_dates (
  date_key TEXT PRIMARY KEY CHECK (length(date_key) = 10),
  city TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 24)
);
