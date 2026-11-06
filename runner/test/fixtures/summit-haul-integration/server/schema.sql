-- Summit Haul Co. — the quote request the approved frontend already asks for.
--
-- SQLite, because that is what the platform's D1 is. The columns are exactly the form's fields, plus the three
-- things any record needs to be useful later: when it arrived, where it came from, and what state it is in.

CREATE TABLE IF NOT EXISTS quote_requests (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  email       TEXT NOT NULL,
  postcode    TEXT NOT NULL,
  load_size   TEXT NOT NULL,
  details     TEXT,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','quoted','booked','declined')),
  source      TEXT NOT NULL DEFAULT 'website',
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS quote_requests_created ON quote_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS quote_requests_status ON quote_requests (status, created_at DESC);
