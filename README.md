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

Pushes to `main` deploy automatically through Cloudflare Workers Builds (the repo is connected to the
`portfolio-server` Worker in the dashboard, Settings → Builds):

- Build command: `npm ci && npm run check`
- Deploy command: `npx wrangler d1 migrations apply portfolio --remote && npx wrangler deploy`

So a new migration in `migrations/` is applied before the code that needs it goes live. Build logs are in the
dashboard. Secrets (`TMDB_TOKEN`, `TURNSTILE_SECRET`, `IP_SALT`, `ADMIN_TOKEN`) are set once on the Worker with
`npx wrangler secret put <NAME>` and are never in the repo.

Hide a pick:

```sh
curl -X DELETE -H "Authorization: Bearer $(cat .admin-token)" \
  https://portfolio-server.manojkumararumainathan.workers.dev/api/admin/picks/<id>
```

TMDB's terms require the credit "This product uses the TMDB API but is not endorsed or certified by TMDB" and
the TMDB logo on the site.
