import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  driver         TEXT    NOT NULL DEFAULT 'zk',     -- 'zk' (real hardware) | 'fake' (synthetic, for demo/tests)
  ip             TEXT    NOT NULL,
  port           INTEGER NOT NULL DEFAULT 4370,
  inport         INTEGER NOT NULL DEFAULT 5200,     -- local UDP port used by the library
  conn_mode      TEXT    NOT NULL DEFAULT 'auto',   -- 'auto' | 'tcp' | 'udp'; auto only falls back on ECONNREFUSED
  comm_key       TEXT,                              -- device password; must be plaintext, it is scrambled per session at connect
  location       TEXT,
  serial         TEXT,                              -- read from the device; stable identity across IP changes
  model          TEXT,
  firmware       TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  live_capture   INTEGER NOT NULL DEFAULT 0,
  last_sync_at   TEXT,
  last_status    TEXT,                              -- 'ok' | 'error' | NULL
  last_error     TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'viewer',   -- 'admin' (full control) | 'viewer' (read + export)
  password_hash TEXT    NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- Server-side sessions: revocable, unlike a signed cookie. Only the SHA-256 of
-- the token is stored, so a database leak does not hand over live sessions.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL,
  user_agent TEXT,
  ip         TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS employees (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,              -- payroll / employee number
  name        TEXT    NOT NULL,
  department  TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Enrollment numbers are per-device. ID 5 on device A is not ID 5 on device B.
CREATE TABLE IF NOT EXISTS device_user_map (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id        INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  device_user_id   TEXT    NOT NULL,
  device_user_name TEXT,
  employee_id      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  first_seen_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (device_id, device_user_id)
);

CREATE TABLE IF NOT EXISTS punches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id      INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  device_serial  TEXT    NOT NULL,                  -- dedup key: survives IP reassignment
  device_user_id TEXT    NOT NULL,
  employee_id    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  punch_local    TEXT    NOT NULL,                  -- 'YYYY-MM-DD HH:MM:SS' as reported by the device clock
  punch_day      TEXT    NOT NULL,                  -- 'YYYY-MM-DD', derived from punch_local
  punch_utc      TEXT    NOT NULL,                  -- ISO-8601, normalised via the server timezone
  punch_type     INTEGER,                           -- device-reported in/out; unreliable on most deployments
  punch_state    INTEGER,                           -- verification mode (fingerprint / card / password)
  raw_time       TEXT,                              -- exactly what the device sent, kept for auditing
  source         TEXT    NOT NULL DEFAULT 'poll',   -- 'poll' | 'live'
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (device_serial, device_user_id, punch_local)
);

CREATE INDEX IF NOT EXISTS idx_punches_day      ON punches(punch_day);
CREATE INDEX IF NOT EXISTS idx_punches_employee ON punches(employee_id, punch_day);
CREATE INDEX IF NOT EXISTS idx_punches_device   ON punches(device_id, punch_day);

CREATE TABLE IF NOT EXISTS sync_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   INTEGER REFERENCES devices(id) ON DELETE CASCADE,
  trigger     TEXT    NOT NULL,                     -- 'manual' | 'scheduled' | 'startup'
  status      TEXT    NOT NULL,                     -- 'ok' | 'error'
  fetched     INTEGER NOT NULL DEFAULT 0,
  inserted    INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  new_users   INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error       TEXT,
  started_at  TEXT    NOT NULL,
  finished_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_started ON sync_logs(started_at DESC);
`);

/**
 * Migrations for databases created before a column existed. `CREATE TABLE IF
 * NOT EXISTS` above only shapes NEW databases — an existing one keeps its old
 * columns, so anything added later has to be ALTERed in here too.
 *
 * Each step is guarded by its own check, so running it twice is harmless.
 */
function migrate() {
  const columns = (table) =>
    db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

  if (!columns('devices').includes('comm_key')) {
    db.exec('ALTER TABLE devices ADD COLUMN comm_key TEXT');
    console.log('[db] migration: added devices.comm_key');
  }

  db.exec('PRAGMA user_version = 1');
}

migrate();

/** Runs `fn` inside a transaction and returns its result. */
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
