import { createHash, randomBytes } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { DatabaseService } from './database.service';

const IDLE_HOURS = 12;

const PUBLIC_ROUTES: { method: string; pattern: RegExp }[] = [
  { method: 'GET', pattern: /^\/api\/?$/ },
  { method: 'GET', pattern: /^\/api\/db\/health\/?$/ },
  { method: 'POST', pattern: /^\/api\/auth\/login\/?$/ },
  { method: 'POST', pattern: /^\/api\/auth\/logout\/?$/ },
  { method: 'GET', pattern: /^\/api\/settings\/branding\/?$/ },
  { method: 'GET', pattern: /^\/api\/settings\/branding\/[^/]+\/image\/?$/ },
];

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function bearerToken(header: string | string[] | undefined) {
  const raw = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/i.exec(String(raw ?? '').trim());
  return match ? match[1] : '';
}

let schemaReady: Promise<void> | null = null;

function ensureSchema(database: DatabaseService) {
  schemaReady ??= database
    .query(
      `CREATE TABLE IF NOT EXISTS erp_session (
         token_hash text PRIMARY KEY,
         username text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         expires_at timestamptz NOT NULL
       )`,
    )
    .then(() => undefined)
    .catch((err) => {
      schemaReady = null;
      throw err;
    });
  return schemaReady;
}

export async function issueToken(database: DatabaseService, username: string) {
  await ensureSchema(database);
  await database.query(`DELETE FROM erp_session WHERE expires_at < now()`);
  const token = randomBytes(32).toString('base64url');
  await database.query(
    `INSERT INTO erp_session (token_hash, username, expires_at)
     VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [hashToken(token), username, IDLE_HOURS],
  );
  return token;
}

export async function revokeToken(database: DatabaseService, token: string) {
  if (!token) return;
  await ensureSchema(database);
  await database.query(`DELETE FROM erp_session WHERE token_hash = $1`, [hashToken(token)]);
}

async function userForToken(database: DatabaseService, token: string) {
  await ensureSchema(database);
  const found = await database.query<{ username: string }>(
    `WITH hit AS (
       SELECT trim(u.tname) AS username
       FROM erp_session s
       JOIN puser u ON upper(trim(u.tname)) = upper(trim(s.username))
       WHERE s.token_hash = $1
         AND s.expires_at > now()
         AND lower(coalesce(trim(u.stat), '')) NOT IN ('blocked', 'block', 'inactive')
       LIMIT 1
     ), touch AS (
       UPDATE erp_session
       SET expires_at = now() + make_interval(hours => $2)
       WHERE token_hash = $1
         AND EXISTS (SELECT 1 FROM hit)
         AND expires_at < now() + make_interval(hours => $2) - interval '5 minutes'
     )
     SELECT username FROM hit`,
    [hashToken(token), IDLE_HOURS],
  );
  return found.rows[0]?.username ?? '';
}

/**
 * The signed-in user comes only from the login token; a client-sent x-ess-user is never trusted.
 */
export function authTokenMiddleware(database: DatabaseService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    delete req.headers['x-ess-user'];
    if (req.method === 'OPTIONS') return next();

    const isPublic = PUBLIC_ROUTES.some(
      (route) => route.method === req.method && route.pattern.test(req.path),
    );
    const token = bearerToken(req.headers.authorization);

    try {
      const username = token ? await userForToken(database, token) : '';
      if (username) {
        req.headers['x-ess-user'] = username;
        return next();
      }
    } catch (err) {
      return next(err);
    }

    if (isPublic) return next();
    res.status(401).json({ statusCode: 401, message: 'Session expired. Please sign in again.' });
  };
}
