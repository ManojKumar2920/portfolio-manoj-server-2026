# portfolio-server

Cloudflare Worker + D1 behind the portfolio's shared 3D world: candles on exhibits and visitors' favourite
movies & series (TMDB). Songs (`kind = 'track'`) come next.

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/whoami` | `{ country }` from Cloudflare's IP geolocation |
| GET | `/api/candles` | `{ counts: { slug: n }, mine: [slug] }` |
| POST | `/api/candles/:slug` | Light a candle (once per visitor; slugs listed in `EXHIBITS`) |
| GET | `/api/search/screen?q=` | TMDB movies & series, trimmed, edge-cached for an hour |
| GET | `/api/picks?kind=screen` | `{ recent (150), top (20) }` visible picks |
| POST | `/api/picks` | `{ kind: 'screen', id: 'movie:157336' \| 'tv:1396', firstName?, turnstile }` |
| DELETE | `/api/admin/picks/:id` | Hide a pick. `Authorization: Bearer <ADMIN_TOKEN>` |

Rules: picks come only from TMDB search results (the server re-reads title, year and poster from TMDB); the
first name is optional (one word, letters only); the country is required and always taken from the request;
Turnstile on every pick; `PICKS_PER_HOUR` per visitor; one pick per title per visitor. No IP is stored, only a
salted hash. Requests from origins not in `ALLOWED_ORIGINS` are refused.

## Local

```sh
npm install
cp .dev.vars.example .dev.vars   # add TMDB_TOKEN
npm run db:migrate:local
npm run dev                      # http://localhost:8787
```

## Deploy

```sh
npx wrangler login
npx wrangler d1 create portfolio          # paste database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put TMDB_TOKEN
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put IP_SALT
npx wrangler secret put ADMIN_TOKEN

npm run deploy
```

TMDB's terms require the credit "This product uses the TMDB API but is not endorsed or certified by TMDB" and
the TMDB logo on the site.
