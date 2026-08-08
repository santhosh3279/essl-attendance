import { db } from '../db.js';
import { COOKIE_NAME, parseCookies, resolveSession } from './sessions.js';

/**
 * Paths under /api reachable without a session. Everything else is denied by
 * default, so a route added later is protected unless it is listed here.
 */
const PUBLIC_PATHS = new Set(['/auth/status', '/auth/login', '/auth/setup', '/health']);

/** Any signed-in user may call these with a non-GET method; the rest need admin. */
const SELF_SERVICE_PREFIX = '/auth/';

export function attachUser(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  req.user = resolveSession(req.cookies[COOKIE_NAME]) ?? null;
  next();
}

export function noUsersYet() {
  return db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get().n === 0;
}

/**
 * Rejects cross-site form posts: a browser form can only send
 * urlencoded/multipart/plain bodies, never application/json. Combined with the
 * SameSite=Strict cookie this covers CSRF for a LAN tool.
 */
export function requireJsonBody(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (type !== 'application/json') {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  return next();
}

export function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (!req.user) return res.status(401).json({ error: 'not signed in' });
  return next();
}

/** Viewers get read-only access: any write needs an admin. */
export function requireAdminForWrites(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.path.startsWith(SELF_SERVICE_PREFIX)) return next();
  if (req.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'admin role required' });
}

export function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'admin role required' });
}
