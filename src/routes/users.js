import { Router } from 'express';
import { db, transaction } from '../db.js';
import { hashPassword, passwordProblem } from '../auth/passwords.js';
import { destroyUserSessions } from '../auth/sessions.js';
import { requireAdmin } from '../auth/middleware.js';

export const usersRouter = Router();

// The account list is admin-only to read as well as to change.
usersRouter.use(requireAdmin);

const ROLES = ['admin', 'viewer'];
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));

const publicUser = (user) => ({
  id: user.id,
  username: user.username,
  name: user.name,
  role: user.role,
  active: !!user.active,
  created_at: user.created_at,
  last_login_at: user.last_login_at,
});

const activeAdminCount = () =>
  db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;

/** Guards every path that could leave the app with no way in. */
function wouldOrphanAdmins(user, { role = user.role, active = user.active } = {}) {
  const stillAdmin = role === 'admin' && Number(active) === 1;
  const wasAdmin = user.role === 'admin' && user.active === 1;
  return wasAdmin && !stillAdmin && activeAdminCount() <= 1;
}

usersRouter.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM sessions s
                     WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS active_sessions
         FROM users u ORDER BY u.active DESC, u.username`,
    )
    .all();
  res.json(rows.map((row) => ({ ...publicUser(row), active_sessions: row.active_sessions })));
});

usersRouter.post('/', async (req, res) => {
  const { username, name, password, role = 'viewer' } = req.body ?? {};
  if (!username || !name) return res.status(400).json({ error: 'username and name are required' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: "role must be 'admin' or 'viewer'" });

  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });

  if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username)) {
    return res.status(409).json({ error: `username '${username}' is taken` });
  }

  const info = db
    .prepare('INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, ?, ?)')
    .run(String(username).trim(), String(name).trim(), role, await hashPassword(password));

  res.status(201).json(publicUser(getUser(info.lastInsertRowid)));
});

usersRouter.put('/:id', async (req, res) => {
  const user = getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });

  const role = req.body.role ?? user.role;
  if (!ROLES.includes(role)) return res.status(400).json({ error: "role must be 'admin' or 'viewer'" });

  const active = req.body.active == null ? user.active : Number(!!req.body.active);
  if (wouldOrphanAdmins(user, { role, active })) {
    return res.status(409).json({ error: 'this is the last active admin — promote someone else first' });
  }

  let passwordHash = user.password_hash;
  if (req.body.password) {
    const problem = passwordProblem(req.body.password);
    if (problem) return res.status(400).json({ error: problem });
    passwordHash = await hashPassword(req.body.password);
  }

  const username = String(req.body.username ?? user.username).trim();
  const clash = db
    .prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id != ?')
    .get(username, user.id);
  if (clash) return res.status(409).json({ error: `username '${username}' is taken` });

  transaction(() => {
    db.prepare(
      'UPDATE users SET username = ?, name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?',
    ).run(username, String(req.body.name ?? user.name).trim(), role, active, passwordHash, user.id);

    // A deactivated user, a demoted user or a reset password must not keep an
    // already-open session working.
    if (!active || role !== user.role || req.body.password) destroyUserSessions(user.id);
  });

  res.json(publicUser(getUser(user.id)));
});

usersRouter.delete('/:id', (req, res) => {
  const user = getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (user.id === req.user.id) return res.status(409).json({ error: 'you cannot delete your own account' });
  if (wouldOrphanAdmins(user, { active: 0 })) {
    return res.status(409).json({ error: 'this is the last active admin — promote someone else first' });
  }

  // Sessions cascade via the foreign key.
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  res.json({ ok: true });
});

/** Force sign-out everywhere for one account. */
usersRouter.post('/:id/sign-out', (req, res) => {
  const user = getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json({ ok: true, sessionsEnded: destroyUserSessions(user.id) });
});
