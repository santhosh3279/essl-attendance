import { db } from '../db.js';
import { config } from '../config.js';
import { minutesBetween, timeOnly, toLocalDay } from '../lib/time.js';

const MAX_RANGE_DAYS = 92;

export function dayList(from, to) {
  const days = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cursor <= end && days.length < MAX_RANGE_DAYS) {
    days.push(toLocalDay(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/** A double-tap on the reader produces two punches seconds apart — treat as one. */
function collapse(punches) {
  const kept = [];
  for (const punch of punches) {
    const last = kept.at(-1);
    if (last && minutesBetween(last.punch_local, punch.punch_local) < config.duplicateWindowMinutes) {
      continue;
    }
    kept.push(punch);
  }
  return kept;
}

function classify(firstIn, lastOut) {
  if (!firstIn) return 'absent';
  if (!lastOut) return 'incomplete';
  return timeOnly(firstIn) > config.workdayStart ? 'late' : 'present';
}

function hoursBetween(firstIn, lastOut) {
  if (!firstIn || !lastOut) return null;
  return Number((minutesBetween(firstIn, lastOut) / 60).toFixed(2));
}

/**
 * Daily attendance per employee, merged across all devices.
 * Punch type/state from the device is deliberately ignored: on most ESSL
 * deployments nobody presses in/out, so first punch = in, last punch = out.
 */
export function getAttendanceGrid({ from, to, employeeId = null, department = null }) {
  const days = dayList(from, to);
  if (days.length === 0) return { days: [], rows: [] };

  const filters = ['p.punch_day BETWEEN ? AND ?', 'p.employee_id IS NOT NULL'];
  const params = [days[0], days.at(-1)];
  if (employeeId) {
    filters.push('p.employee_id = ?');
    params.push(employeeId);
  }
  if (department) {
    filters.push('e.department = ?');
    params.push(department);
  }

  const punches = db
    .prepare(
      `SELECT p.employee_id, p.punch_day, p.punch_local, p.source, d.name AS device_name
         FROM punches p
         JOIN employees e ON e.id = p.employee_id
         LEFT JOIN devices d ON d.id = p.device_id
        WHERE ${filters.join(' AND ')}
        ORDER BY p.employee_id, p.punch_day, p.punch_local`,
    )
    .all(...params);

  const employeeFilters = ['active = 1'];
  const employeeParams = [];
  if (employeeId) {
    employeeFilters.push('id = ?');
    employeeParams.push(employeeId);
  }
  if (department) {
    employeeFilters.push('department = ?');
    employeeParams.push(department);
  }
  const employees = db
    .prepare(
      `SELECT id, code, name, department FROM employees
        WHERE ${employeeFilters.join(' AND ')} ORDER BY name`,
    )
    .all(...employeeParams);

  const grouped = new Map(); // `${employeeId}|${day}` -> punches
  for (const punch of punches) {
    const key = `${punch.employee_id}|${punch.punch_day}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(punch);
  }

  const rows = [];
  for (const employee of employees) {
    for (const day of days) {
      const dayPunches = collapse(grouped.get(`${employee.id}|${day}`) ?? []);
      const firstIn = dayPunches[0]?.punch_local ?? null;
      const lastOut = dayPunches.length > 1 ? dayPunches.at(-1).punch_local : null;

      rows.push({
        employeeId: employee.id,
        code: employee.code,
        name: employee.name,
        department: employee.department,
        day,
        firstIn: timeOnly(firstIn),
        lastOut: timeOnly(lastOut),
        punches: dayPunches.length,
        hours: hoursBetween(firstIn, lastOut),
        devices: [...new Set(dayPunches.map((p) => p.device_name).filter(Boolean))],
        status: classify(firstIn, lastOut),
      });
    }
  }

  return { days, rows };
}

export function getDashboardStats() {
  const today = toLocalDay(new Date());

  const employees = db
    .prepare('SELECT COUNT(*) AS n FROM employees WHERE active = 1')
    .get().n;
  const presentToday = db
    .prepare(
      `SELECT COUNT(DISTINCT employee_id) AS n FROM punches
        WHERE punch_day = ? AND employee_id IS NOT NULL`,
    )
    .get(today).n;
  const punchesToday = db
    .prepare('SELECT COUNT(*) AS n FROM punches WHERE punch_day = ?')
    .get(today).n;
  const unmapped = db
    .prepare(
      `SELECT COUNT(*) AS n FROM device_user_map WHERE employee_id IS NULL`,
    )
    .get().n;
  const devices = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN last_status = 'ok' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN last_status = 'error' THEN 1 ELSE 0 END) AS failing
         FROM devices WHERE enabled = 1`,
    )
    .get();

  const recent = db
    .prepare(
      `SELECT p.punch_local, p.device_user_id, p.source,
              e.name AS employee_name, e.code AS employee_code, d.name AS device_name
         FROM punches p
         LEFT JOIN employees e ON e.id = p.employee_id
         LEFT JOIN devices d ON d.id = p.device_id
        ORDER BY p.punch_local DESC LIMIT 15`,
    )
    .all();

  return {
    today,
    employees,
    presentToday,
    absentToday: Math.max(employees - presentToday, 0),
    punchesToday,
    unmapped,
    devices: {
      total: devices.total ?? 0,
      ok: devices.ok ?? 0,
      failing: devices.failing ?? 0,
    },
    recent,
  };
}

export function getRawPunches({ from, to, deviceId = null, limit = 500 }) {
  const filters = ['p.punch_day BETWEEN ? AND ?'];
  const params = [from, to];
  if (deviceId) {
    filters.push('p.device_id = ?');
    params.push(deviceId);
  }
  return db
    .prepare(
      `SELECT p.id, p.punch_local, p.device_user_id, p.punch_type, p.source,
              e.name AS employee_name, e.code AS employee_code, d.name AS device_name
         FROM punches p
         LEFT JOIN employees e ON e.id = p.employee_id
         LEFT JOIN devices d ON d.id = p.device_id
        WHERE ${filters.join(' AND ')}
        ORDER BY p.punch_local DESC
        LIMIT ?`,
    )
    .all(...params, limit);
}

export function toCsv(rows, columns) {
  const escape = (value) => {
    if (value == null) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = columns.map((c) => escape(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => escape(c.get(row))).join(','));
  return [header, ...body].join('\n');
}
