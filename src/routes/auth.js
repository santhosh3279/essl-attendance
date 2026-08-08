import { Router } from 'express';
import { db, transaction } from '../db.js';
import { hashPassword, verifyPassword, fakeVerify, passwordProblem } from '../auth/passwords.js';
import {
  COOKIE_NAME,
  createSession,
  destroySession,
  destroyUserSessions,
  sessionCookie,
  clearedCookie,
} from '../auth/sessions.js';
import { noUsersYet } from '../auth/middleware.js';

export const authRouter = Router();

const LOCKOUT_MS = 15 * 60_000;

// Per-username is tight: it is the account actually under attack.
// Per-address is deliberately loose — several people can share one IP (NAT, or a
// reverse proxy later), and a strict limit there lets one attacker lock out an
// entire office. The window is capped, never escalating.
const LIMITS = { user: 5, ip: 20 };

// In-memory, single process: a restart clears it. Good enough for a LAN tool.
const attempts = new Map();

/** Drops entries whose window has passed — a scan of many usernames would
 *  otherwise leave a key per guess that nothing ever revisits. */
export function pruneLoginAttempts() {
  const cutoff = Date.now() - LOCKOUT_MS;
  let removed = 0;
  for (const [key, record] of attempts) {
    if (record.first < cutoff) {
      attempts.delete(key);
      removed += 1;
    }
  }
  return removed;
}

function lockedOut(key) {
  const record = attempts.get(key);
  if (!record) return 0;
  if (Date.now() - record.first > LOCKOUT_MS) {
    attempts.delete(key);
    return 0;
  }
  if (record.count < LIMITS[key.split(':')[0]]) return 0;
  return Math.ceil((LOCKOUT_MS - (Date.now() - record.first)) / 60_000);
}

function recordFailure(key) {
  const record = attempts.get(key);
  if (!record || Date.now() - record.first > LOCKOUT_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
    return;
  }
  record.count += 1;
}

const publicUser = (user) =>
  user && { id: user.id, username: user.username, name: user.name, role: user.role };

authRouter.get('/status', (req, res) => {
  res.json({
    authenticated: !!req.user,
    needsSetup: noUsersYet(),
    user: publicUser(req.user),
  });
});

/** Creates the very first admin. Refuses once any active user exists. */
authRouter.post('/setup', async (req, res) => {
  const { username, name, password } = req.body ?? {};
  if (!username || !name) return res.status(400).json({ error: 'username and name are required' });

  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });

  const passwordHash = await hashPassword(password);

  let created;
  try {
    // Count and insert in one transaction: two simultaneous requests must not
    // both see an empty table and both create an admin.
    created = transaction(() => {
      if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return null;
      const info = db
        .prepare(
          "INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, 'admin', ?)",
        )
        .run(String(username).trim(), String(name).trim(), passwordHash);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!created) return res.status(409).json({ error: 'setup already completed' });

  const token = createSession(created.id, {
    userAgent: req.headers['user-agent'] ?? null,
    ip: req.ip,
  });
  res.setHeader('Set-Cookie', sessionCookie(token));
  res.status(201).json({ ok: true, user: publicUser(created) });
});

authRouter.post('/login', async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  // Keyed separately so one attacked account cannot lock out a whole office,
  // and one noisy host cannot be hidden behind many usernames.
  const keys = [`user:${username.toLowerCase()}`, `ip:${req.ip}`];
  for (const key of keys) {
    const minutes = lockedOut(key);
    if (minutes) {
      return res
        .status(429)
        .json({ error: `too many failed attempts — try again in ${minutes} minute(s)` });
    }
  }

  const user = db
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(username);

  // Always spend the same time, whether or not the username exists.
  const ok = user && user.active
    ? await verifyPassword(password, user.password_hash)
    : await fakeVerify();

  if (!ok) {
    for (const key of keys) recordFailure(key);
    return res.status(401).json({ error: 'wrong username or password' });
  }

  for (const key of keys) attempts.delete(key);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);

  const token = createSession(user.id, {
    userAgent: req.headers['user-agent'] ?? null,
    ip: req.ip,
  });
  res.setHeader('Set-Cookie', sessionCookie(token));
  res.json({ ok: true, user: publicUser(user) });
});

authRouter.post('/logout', (req, res) => {
  destroySession(req.cookies?.[COOKIE_NAME]);
  res.setHeader('Set-Cookie', clearedCookie());
  res.json({ ok: true });
});

authRouter.post('/change-password', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not signed in' });

  const { currentPassword, newPassword } = req.body ?? {};
  const problem = passwordProblem(newPassword);
  if (problem) return res.status(400).json({ error: problem });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!(await verifyPassword(String(currentPassword ?? ''), user.password_hash))) {
    return res.status(401).json({ error: 'current password is wrong' });
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    await hashPassword(newPassword),
    user.id,
  );

  // Sign out everywhere else, but keep the session that made the change.
  const signedOut = destroyUserSessions(user.id, { exceptTokenHash: req.user.tokenHash });
  res.json({ ok: true, otherSessionsEnded: signedOut });
});
