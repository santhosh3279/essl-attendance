import { Router } from 'express';
import { db } from '../db.js';
import {
  getAttendanceGrid,
  getDashboardStats,
  getRawPunches,
  toCsv,
} from '../services/attendanceService.js';
import { toLocalDay } from '../lib/time.js';

export const attendanceRouter = Router();

function range(query) {
  const today = toLocalDay(new Date());
  const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const from = isDay(query.from) ? query.from : today;
  const to = isDay(query.to) ? query.to : from;
  return from <= to ? { from, to } : { from: to, to: from };
}

attendanceRouter.get('/dashboard', (req, res) => {
  res.json(getDashboardStats());
});

attendanceRouter.get('/attendance', (req, res) => {
  const { from, to } = range(req.query);
  res.json({
    from,
    to,
    ...getAttendanceGrid({
      from,
      to,
      employeeId: req.query.employeeId ? Number(req.query.employeeId) : null,
      department: req.query.department || null,
    }),
  });
});

attendanceRouter.get('/attendance.csv', (req, res) => {
  const { from, to } = range(req.query);
  const { rows } = getAttendanceGrid({
    from,
    to,
    employeeId: req.query.employeeId ? Number(req.query.employeeId) : null,
    department: req.query.department || null,
  });

  const csv = toCsv(rows, [
    { label: 'Date', get: (r) => r.day },
    { label: 'Code', get: (r) => r.code },
    { label: 'Employee', get: (r) => r.name },
    { label: 'Department', get: (r) => r.department },
    { label: 'First In', get: (r) => r.firstIn },
    { label: 'Last Out', get: (r) => r.lastOut },
    { label: 'Hours', get: (r) => r.hours },
    { label: 'Punches', get: (r) => r.punches },
    { label: 'Devices', get: (r) => r.devices.join(' | ') },
    { label: 'Status', get: (r) => r.status },
  ]);

  res.type('text/csv').attachment(`attendance_${from}_to_${to}.csv`).send(csv);
});

attendanceRouter.get('/punches', (req, res) => {
  const { from, to } = range(req.query);
  res.json(
    getRawPunches({
      from,
      to,
      deviceId: req.query.deviceId ? Number(req.query.deviceId) : null,
      limit: Math.min(Number(req.query.limit) || 500, 5000),
    }),
  );
});

attendanceRouter.get('/punches.csv', (req, res) => {
  const { from, to } = range(req.query);
  const rows = getRawPunches({
    from,
    to,
    deviceId: req.query.deviceId ? Number(req.query.deviceId) : null,
    limit: 50000,
  });

  const csv = toCsv(rows, [
    { label: 'Timestamp', get: (r) => r.punch_local },
    { label: 'Device', get: (r) => r.device_name },
    { label: 'Device User ID', get: (r) => r.device_user_id },
    { label: 'Code', get: (r) => r.employee_code },
    { label: 'Employee', get: (r) => r.employee_name },
    { label: 'Source', get: (r) => r.source },
  ]);

  res.type('text/csv').attachment(`punches_${from}_to_${to}.csv`).send(csv);
});

attendanceRouter.get('/departments', (req, res) => {
  const rows = db
    .prepare(
      "SELECT DISTINCT department FROM employees WHERE department IS NOT NULL AND department != '' ORDER BY department",
    )
    .all();
  res.json(rows.map((r) => r.department));
});
