import crypto from 'node:crypto';
import { db } from '../db.js';

export const COOKIE_NAME = 'attendance_sid';
const LIFETIME_HOURS = 8;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Minimal cookie header parser — avoids a dependency for one header. */
export function parseCookies(header) {
  const jar = {};
  if (!header) return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}

export function createSession(userId, { userAgent = null, ip = null } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip)
     VALUES (?, ?, datetime('now', ?), ?, ?)`,
  ).run(hashToken(token), userId, `+${LIFETIME_HOURS} hours`, userAgent, ip);
  return token;
}

/** Returns the active user for a token, sliding the expiry forward. */
export function resolveSession(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);

  const row = db
    .prepare(
      `SELECT u.id, u.username, u.name, u.role, u.active
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
    )
    .get(tokenHash);

  // A deactivated account must not keep working until its session expires.
  if (!row || !row.active) {
    if (row) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }

  db.prepare("UPDATE sessions SET expires_at = datetime('now', ?) WHERE token_hash = ?").run(
    `+${LIFETIME_HOURS} hours`,
    tokenHash,
  );

  return { id: row.id, username: row.username, name: row.name, role: row.role, tokenHash };
}

/** Cheap existence check for long-lived connections (SSE) — no expiry slide. */
export function sessionStillValid(tokenHash) {
  return !!db
    .prepare("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')")
    .get(tokenHash);
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function destroyUserSessions(userId, { exceptTokenHash = null } = {}) {
  if (exceptTokenHash) {
    return db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
      .run(userId, exceptTokenHash).changes;
  }
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

export function pruneExpiredSessions() {
  return db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run().changes;
}

export function sessionCookie(token) {
  // No `Secure`: this runs over plain HTTP on a LAN, and Secure would stop the
  // browser sending the cookie at all. Put it behind TLS and add it.
  const attributes = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${LIFETIME_HOURS * 3600}`,
  ];
  return attributes.join('; ');
}

export function clearedCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
