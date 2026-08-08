import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { devicesRouter } from './routes/devices.js';
import { employeesRouter, mappingsRouter } from './routes/employees.js';
import { attendanceRouter } from './routes/attendance.js';
import { syncRouter } from './routes/sync.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import {
  attachUser,
  requireAuth,
  requireAdminForWrites,
  requireJsonBody,
} from './auth/middleware.js';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Builds the HTTP app. Kept separate from index.js so tests can mount it. */
export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(rootDir, 'public')));

  // The gate is mounted on /api BEFORE any feature router, so anything added
  // later is protected unless it is explicitly listed as public in
  // auth/middleware.js. Adding a guard per router is how endpoints end up open.
  app.use('/api', attachUser, requireJsonBody, requireAuth, requireAdminForWrites);

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/devices', devicesRouter);
  app.use('/api/employees', employeesRouter);
  app.use('/api/mappings', mappingsRouter);
  app.use('/api', attendanceRouter);
  app.use('/api', syncRouter);

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      env: config.env,
      host: config.host,
      port: config.port,
      db: config.dbPath,
      poll: config.pollIntervalMinutes,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'unknown endpoint' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[http]', err);
    res.status(500).json({ error: err?.message || 'internal error' });
  });

  return app;
}
