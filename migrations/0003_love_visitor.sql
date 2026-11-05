-- Loves were keyed by a hash of the IP, so everyone behind one address (a home, an office, a mobile carrier's shared
-- IP) counted as one visitor and all saw "You love this". The voter is now a per-browser id; the IP hash is kept beside
-- it only to rate-limit. Rows from before have ip NULL.
ALTER TABLE candles ADD COLUMN ip TEXT;
CREATE INDEX candles_ip ON candles (ip, created_at);
