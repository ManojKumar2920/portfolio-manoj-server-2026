/**
 * portfolio-server: the small API behind the portfolio's shared 3D world.
 *
 *   GET  /api/whoami                      → the visitor's country (from Cloudflare's IP geolocation)
 *   GET  /api/loves                       → { counts: { [slug]: n }, mine: slug[] }  (alias: /api/candles)
 *   POST /api/loves/:slug                 → love an exhibit (once per visitor)
 *   GET  /api/search/screen?q=            → TMDB movies & series, trimmed for the picker
 *   GET  /api/picks?kind=screen           → the sky: one star per title (most picked + newest), edge-cached 60 s
 *   POST /api/picks                       → { kind: 'screen', id: 'movie:157336', firstName?, turnstile }
 *   DELETE /api/admin/picks/:id           → hide a pick (Bearer ADMIN_TOKEN)
 *
 * Privacy: no IP is stored. Visitors are identified only by a salted hash of the IP, for de-duplication and rate
 * limits. A first name is optional; the country is required and comes from the request, not the visitor.
 */

const TMDB = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';

type Json = Record<string, unknown> | unknown[];

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const origin = req.headers.get('Origin');
    const cors = corsHeaders(origin, env);
    // a browser on any other site gets nothing, writes included (simple POSTs skip the preflight)
    if (!cors) return json({ error: 'Origin not allowed' }, 403);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(req, env, ctx);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return json({ error: err instanceof HttpError ? err.message : 'Something went wrong' }, status, cors);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const m = req.method;

  if (m === 'GET' && path === '/api/whoami') return json({ country: country(req) });

  // loves: a heart per exhibit, once per visitor (stored in the candles table; /api/candles kept as an alias)
  if (m === 'GET' && (path === '/api/loves' || path === '/api/candles')) return getCandles(req, env);
  const candle = path.match(/^\/api\/(?:loves|candles)\/([a-z0-9-]{1,48})$/);
  if (m === 'POST' && candle) return lightCandle(req, env, candle[1]);

  if (m === 'GET' && path === '/api/search/screen') return searchScreen(url, env, ctx);

  if (m === 'GET' && path === '/api/picks') return getPicks(url, env, ctx);
  if (m === 'POST' && path === '/api/picks') return addPick(req, env);

  const hide = path.match(/^\/api\/admin\/picks\/(\d+)$/);
  if (m === 'DELETE' && hide) return hidePick(req, env, Number(hide[1]));

  throw new HttpError(404, 'Not found');
}

/* ---------------- candles ---------------- */

async function getCandles(req: Request, env: Env) {
  const voter = await voterId(req, env);
  const [counts, mine] = await env.DB.batch<{ slug: string; n?: number }>([
    env.DB.prepare('SELECT slug, COUNT(*) AS n FROM candles GROUP BY slug'),
    env.DB.prepare('SELECT slug FROM candles WHERE voter = ?').bind(voter),
  ]);
  return json({
    counts: Object.fromEntries(counts.results.map((r) => [r.slug, r.n ?? 0])),
    mine: mine.results.map((r) => r.slug),
  });
}

async function lightCandle(req: Request, env: Env, slug: string) {
  if (!env.EXHIBITS.split(',').includes(slug)) throw new HttpError(404, 'Unknown exhibit');
  const voter = await voterId(req, env);
  await env.DB.prepare('INSERT OR IGNORE INTO candles (slug, voter, created_at) VALUES (?, ?, ?)')
    .bind(slug, voter, Date.now())
    .run();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM candles WHERE slug = ?').bind(slug).first<{ n: number }>();
  return json({ slug, count: row?.n ?? 0, lit: true });
}

/* ---------------- TMDB search ---------------- */

interface TmdbResult {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  popularity?: number;
  adult?: boolean;
}

const trimTmdb = (r: TmdbResult, type: 'movie' | 'tv') => ({
  id: `${type}:${r.id}`,
  type,
  title: (type === 'movie' ? r.title : r.name) ?? '',
  year: ((type === 'movie' ? r.release_date : r.first_air_date) ?? '').slice(0, 4) || null,
  poster: r.poster_path ? TMDB_IMG + r.poster_path : null,
});

async function tmdb<T>(env: Env, path: string, params: Record<string, string> = {}): Promise<T> {
  if (!env.TMDB_TOKEN) throw new HttpError(503, 'Search is not configured');
  const u = new URL(TMDB + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { Authorization: `Bearer ${env.TMDB_TOKEN}`, Accept: 'application/json' } }).catch((err) => {
    console.error('TMDB fetch failed', err);
    throw new HttpError(502, 'TMDB is unavailable, please try again');
  });
  if (res.status === 404) throw new HttpError(404, 'Not found on TMDB');
  if (!res.ok) throw new HttpError(502, 'TMDB is unavailable');
  return res.json<T>();
}

async function searchScreen(url: URL, env: Env, ctx: ExecutionContext) {
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80);
  if (q.length < 2) return json({ results: [] });
  // shared edge cache: the same query from many visitors hits TMDB once
  const cacheKey = new Request(`https://cache.internal/search/screen?q=${encodeURIComponent(q.toLowerCase())}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return new Response(hit.body, hit);

  const data = await tmdb<{ results: TmdbResult[] }>(env, '/search/multi', { query: q, include_adult: 'false', page: '1' });
  const results = data.results
    .filter((r) => !r.adult && (r.media_type === 'movie' || r.media_type === 'tv'))
    .slice(0, 12)
    .map((r) => trimTmdb(r, r.media_type as 'movie' | 'tv'));
  const res = json({ results }, 200, { 'Cache-Control': 'public, max-age=3600' });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

/* ---------------- favourites ---------------- */

/**
 * The sky: one star per title, however many people picked it. 10k picks of ~3k titles still come back as at most
 * STAR_LIMIT stars: the most picked, plus the newest so a fresh pick always shows up. Shared by every visitor, so the
 * answer is cached at the edge for a minute (the visitor who just added a star draws it locally at once).
 */
const STAR_LIMIT = 300;
const NEWEST_LIMIT = 100;

interface StarRow {
  ext_id: string;
  title: string;
  year: string | null;
  image: string | null;
  first_name: string | null;
  country: string;
  n: number;
  last: number;
}

async function getPicks(url: URL, env: Env, ctx: ExecutionContext) {
  const kind = url.searchParams.get('kind') ?? 'screen';
  if (kind !== 'screen') throw new HttpError(400, 'Unknown kind');
  const cacheKey = new Request(`https://cache.internal/picks?kind=${kind}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return new Response(hit.body, hit);

  const [stars, totals] = await env.DB.batch([
    env.DB.prepare(
      `WITH g AS (
         SELECT ext_id, COUNT(*) AS n, MAX(created_at) AS last FROM picks WHERE kind = ?1 AND hidden = 0 GROUP BY ext_id
       ), chosen AS (
         SELECT ext_id FROM (SELECT ext_id FROM g ORDER BY n DESC, last DESC LIMIT ?2)
         UNION
         SELECT ext_id FROM (SELECT ext_id FROM g ORDER BY last DESC LIMIT ?3)
       )
       SELECT p.ext_id, p.title, p.year, p.image, p.first_name, p.country, g.n, g.last
       FROM g JOIN chosen c ON c.ext_id = g.ext_id
       JOIN picks p ON p.kind = ?1 AND p.hidden = 0 AND p.ext_id = g.ext_id AND p.created_at = g.last
       GROUP BY p.ext_id
       ORDER BY g.n DESC, g.last DESC`,
    ).bind(kind, STAR_LIMIT, NEWEST_LIMIT),
    env.DB.prepare('SELECT COUNT(*) AS picks, COUNT(DISTINCT ext_id) AS titles FROM picks WHERE kind = ? AND hidden = 0').bind(kind),
  ]);
  const t = (totals.results[0] ?? { picks: 0, titles: 0 }) as { picks: number; titles: number };
  const res = json(
    {
      total: { picks: t.picks, titles: t.titles },
      stars: (stars.results as unknown as StarRow[]).map((r) => ({
        ref: r.ext_id,
        title: r.title,
        year: r.year,
        poster: r.image ? TMDB_IMG + r.image : null,
        count: r.n,
        // the latest person to pick it
        firstName: r.first_name,
        country: r.country,
      })),
    },
    200,
    { 'Cache-Control': 'public, max-age=60' },
  );
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function addPick(req: Request, env: Env) {
  const body = await readJson(req);
  if (body.kind !== 'screen') throw new HttpError(400, 'Unknown kind');

  const ref = typeof body.id === 'string' ? body.id.match(/^(movie|tv):(\d{1,10})$/) : null;
  if (!ref) throw new HttpError(400, 'Pick a title from the search results');
  const firstName = cleanFirstName(body.firstName);

  const where = country(req);
  if (!where) throw new HttpError(400, "We couldn't tell which country you're in");

  await verifyTurnstile(req, env, body.turnstile);
  const voter = await voterId(req, env);

  const perHour = Number(env.PICKS_PER_HOUR) || 5;
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM picks WHERE voter = ? AND created_at > ?')
    .bind(voter, Date.now() - 3600_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= perHour) throw new HttpError(429, 'That is plenty for now. Try again in an hour.');

  // the title, year and poster come from TMDB, never from the client
  const type = ref[1] as 'movie' | 'tv';
  const detail = await tmdb<TmdbResult>(env, `/${type}/${ref[2]}`);
  if (detail.adult) throw new HttpError(400, 'That title cannot be added');
  const item = trimTmdb(detail, type);
  if (!item.title) throw new HttpError(400, 'That title cannot be added');

  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO picks (kind, source, ext_id, title, year, image, first_name, country, voter, created_at)
     VALUES ('screen', 'tmdb', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(item.id, item.title.slice(0, 200), item.year, detail.poster_path ?? null, firstName, where, voter, Date.now())
    .run();
  if (!res.meta.changes) throw new HttpError(409, "You've already added this one");

  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM picks WHERE kind = ? AND hidden = 0 AND ext_id = ?').bind('screen', item.id).first<{ n: number }>();
  return json(
    { star: { ref: item.id, title: item.title, year: item.year, poster: item.poster, count: n?.n ?? 1, firstName, country: where } },
    201,
  );
}

async function hidePick(req: Request, env: Env, id: number) {
  const auth = req.headers.get('Authorization') ?? '';
  if (!env.ADMIN_TOKEN || !(await sameSecret(auth, `Bearer ${env.ADMIN_TOKEN}`))) throw new HttpError(401, 'Unauthorized');
  const res = await env.DB.prepare('UPDATE picks SET hidden = 1 WHERE id = ?').bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, 'No such pick');
  return json({ id, hidden: true });
}

/* ---------------- helpers ---------------- */

function json(data: Json, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> | null {
  if (!origin) return {}; // same-origin or server-to-server: nothing to add
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  if (!allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** ISO country code from Cloudflare's geolocation; null when unknown (XX) or Tor (T1). */
function country(req: Request): string | null {
  const c = (req.cf?.country as string | undefined) ?? req.headers.get('CF-IPCountry');
  return c && /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null;
}

async function voterId(req: Request, env: Env) {
  const ip = req.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.IP_SALT}|${ip}`));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (!(req.headers.get('Content-Type') ?? '').includes('application/json')) throw new HttpError(415, 'Send JSON');
  const text = await req.text();
  if (text.length > 4096) throw new HttpError(413, 'Too large');
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  throw new HttpError(400, 'Invalid JSON');
}

// a short list on purpose: names are one word of letters, so most abuse is already impossible
const BLOCKED = ['fuck', 'shit', 'bitch', 'cunt', 'dick', 'pussy', 'nigg', 'fag', 'slut', 'whore', 'rape', 'nazi', 'porn', 'sex', 'admin', 'http', 'www'];

/** Optional first name: one word of letters (any script), with ' or - inside, up to 20 characters. */
function cleanFirstName(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new HttpError(400, 'Invalid name');
  const name = v.normalize('NFC').trim();
  if (!name) return null;
  if (!/^\p{L}[\p{L}\p{M}'’-]{0,19}$/u.test(name)) throw new HttpError(400, 'Use just your first name, letters only');
  const lower = name.toLowerCase();
  if (BLOCKED.some((w) => lower.includes(w))) throw new HttpError(400, 'Please use a different name');
  return name;
}

async function verifyTurnstile(req: Request, env: Env, token: unknown) {
  if (typeof token !== 'string' || !token || token.length > 2048) throw new HttpError(400, 'Please complete the check');
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET);
  form.set('response', token);
  const ip = req.headers.get('CF-Connecting-IP');
  if (ip) form.set('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const out = await res.json<{ success: boolean }>();
  if (!out.success) throw new HttpError(403, 'The check failed. Please try again.');
}

/** Constant-time comparison (via digests) for the admin token. */
async function sameSecret(a: string, b: string) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(da, db);
}
