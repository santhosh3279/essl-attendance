import path from 'node:path';

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '127.0.0.1',
  dbPath: path.resolve(process.env.DB_PATH || './data/attendance.db'),
  pollIntervalMinutes: num(process.env.POLL_INTERVAL_MINUTES, 10),
  deviceTimeoutMs: num(process.env.DEVICE_TIMEOUT_SECONDS, 10) * 1000,
  workdayStart: process.env.WORKDAY_START || '09:00',
  workdayEnd: process.env.WORKDAY_END || '18:00',
  duplicateWindowMinutes: num(process.env.DUPLICATE_PUNCH_WINDOW_MINUTES, 1),
};
