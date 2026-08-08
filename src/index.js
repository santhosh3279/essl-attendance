import { config } from './config.js';
import { db } from './db.js';
import { createApp } from './app.js';
import { pruneExpiredSessions } from './auth/sessions.js';
import { pruneLoginAttempts } from './routes/auth.js';
import { startScheduler, stopScheduler, startConfiguredLiveCapture } from './sync/scheduler.js';
import { stopAllLiveCapture } from './devices/registry.js';

const app = createApp();

const server = app.listen(config.port, config.host, () => {
  console.log(`ESSL attendance [${config.env}] on http://${config.host}:${config.port}`);
  console.log(`database: ${config.dbPath}`);
  startScheduler();
  startConfiguredLiveCapture();

  pruneExpiredSessions();
  setInterval(() => {
    pruneExpiredSessions();
    pruneLoginAttempts();
  }, 60 * 60_000).unref();
});

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down`);
  stopScheduler();
  await stopAllLiveCapture();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
