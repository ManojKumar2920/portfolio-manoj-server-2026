-- One star per title: /api/picks groups by ext_id, so index the grouping (visible picks of a kind, by title, by time).
CREATE INDEX picks_title ON picks (kind, hidden, ext_id, created_at);
