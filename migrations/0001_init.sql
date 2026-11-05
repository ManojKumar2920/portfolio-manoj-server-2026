-- Visitors never get stored by IP: `voter` is a salted SHA-256 of the IP (see src/index.ts), used only for
-- de-duplication and rate limits.

-- "Light a candle" on a work exhibit: one per visitor per exhibit.
CREATE TABLE candles (
  slug       TEXT NOT NULL,
  voter      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (slug, voter)
);

-- Visitors' favourites. kind = 'screen' (TMDB movies & series); 'track' is reserved for songs later.
-- Title, year and poster are copied from TMDB on the server, never taken from the client.
CREATE TABLE picks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('screen', 'track')),
  source      TEXT NOT NULL,          -- 'tmdb'
  ext_id      TEXT NOT NULL,          -- e.g. 'movie:157336' or 'tv:1396'
  title       TEXT NOT NULL,
  year        TEXT,
  image       TEXT,                   -- poster path on the source's CDN
  first_name  TEXT,                   -- optional, validated
  country     TEXT NOT NULL,          -- ISO 3166-1 alpha-2, from Cloudflare's IP geolocation
  voter       TEXT NOT NULL,
  hidden      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX picks_once ON picks (voter, kind, ext_id);
CREATE INDEX picks_recent ON picks (kind, hidden, created_at DESC);
CREATE INDEX picks_voter_time ON picks (voter, created_at);
