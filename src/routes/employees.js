import { Router } from 'express';
import { db, transaction } from '../db.js';

export const employeesRouter = Router();

const getEmployee = (id) => db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(id));

employeesRouter.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT e.*,
              (SELECT COUNT(*) FROM device_user_map m WHERE m.employee_id = e.id) AS mapped_devices,
              (SELECT COUNT(*) FROM punches p WHERE p.employee_id = e.id) AS punch_count
         FROM employees e
        ORDER BY e.active DESC, e.name`,
    )
    .all();
  res.json(rows.map((row) => ({ ...row, active: !!row.active })));
});

employeesRouter.post('/', (req, res) => {
  const { code, name, department } = req.body ?? {};
  if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
  if (db.prepare('SELECT 1 FROM employees WHERE code = ?').get(code)) {
    return res.status(409).json({ error: `employee code '${code}' already exists` });
  }

  const info = db
    .prepare('INSERT INTO employees (code, name, department) VALUES (?, ?, ?)')
    .run(String(code), String(name), department || null);
  res.status(201).json(getEmployee(info.lastInsertRowid));
});

employeesRouter.put('/:id', (req, res) => {
  const employee = getEmployee(req.params.id);
  if (!employee) return res.status(404).json({ error: 'employee not found' });

  const code = req.body.code ?? employee.code;
  const clash = db.prepare('SELECT id FROM employees WHERE code = ? AND id != ?').get(code, employee.id);
  if (clash) return res.status(409).json({ error: `employee code '${code}' already exists` });

  db.prepare('UPDATE employees SET code = ?, name = ?, department = ?, active = ? WHERE id = ?').run(
    code,
    req.body.name ?? employee.name,
    req.body.department ?? employee.department,
    req.body.active == null ? employee.active : Number(!!req.body.active),
    employee.id,
  );
  res.json(getEmployee(employee.id));
});

employeesRouter.delete('/:id', (req, res) => {
  const employee = getEmployee(req.params.id);
  if (!employee) return res.status(404).json({ error: 'employee not found' });

  // Punch history is kept; it just goes back to being unattributed.
  db.prepare('DELETE FROM employees WHERE id = ?').run(employee.id);
  res.json({ ok: true });
});

export const mappingsRouter = Router();

mappingsRouter.get('/', (req, res) => {
  const onlyUnmapped = req.query.unmapped === '1';
  const rows = db
    .prepare(
      `SELECT m.id, m.device_id, m.device_user_id, m.device_user_name, m.employee_id,
              d.name AS device_name, e.name AS employee_name, e.code AS employee_code,
              (SELECT COUNT(*) FROM punches p
                WHERE p.device_id = m.device_id AND p.device_user_id = m.device_user_id) AS punch_count
         FROM device_user_map m
         LEFT JOIN devices d ON d.id = m.device_id
         LEFT JOIN employees e ON e.id = m.employee_id
        ${onlyUnmapped ? 'WHERE m.employee_id IS NULL' : ''}
        ORDER BY (m.employee_id IS NOT NULL), d.name, CAST(m.device_user_id AS INTEGER)`,
    )
    .all();
  res.json(rows);
});

/** Links a device enrollment number to an employee and backfills past punches. */
mappingsRouter.put('/:id', (req, res) => {
  const mapping = db.prepare('SELECT * FROM device_user_map WHERE id = ?').get(Number(req.params.id));
  if (!mapping) return res.status(404).json({ error: 'mapping not found' });

  const employeeId = req.body.employeeId == null || req.body.employeeId === ''
    ? null
    : Number(req.body.employeeId);

  if (employeeId != null && !getEmployee(employeeId)) {
    return res.status(400).json({ error: 'employee not found' });
  }

  const backfilled = transaction(() => {
    db.prepare('UPDATE device_user_map SET employee_id = ? WHERE id = ?').run(employeeId, mapping.id);
    const result = db
      .prepare('UPDATE punches SET employee_id = ? WHERE device_id = ? AND device_user_id = ?')
      .run(employeeId, mapping.device_id, mapping.device_user_id);
    return result.changes;
  });

  res.json({ ok: true, backfilled });
});

/** Creates an employee straight from an unmapped device user and links it. */
mappingsRouter.post('/:id/create-employee', (req, res) => {
  const mapping = db.prepare('SELECT * FROM device_user_map WHERE id = ?').get(Number(req.params.id));
  if (!mapping) return res.status(404).json({ error: 'mapping not found' });

  const code = String(req.body.code || mapping.device_user_id);
  const name = String(req.body.name || mapping.device_user_name || `User ${mapping.device_user_id}`);
  if (db.prepare('SELECT 1 FROM employees WHERE code = ?').get(code)) {
    return res.status(409).json({ error: `employee code '${code}' already exists` });
  }

  const result = transaction(() => {
    const info = db
      .prepare('INSERT INTO employees (code, name, department) VALUES (?, ?, ?)')
      .run(code, name, req.body.department || null);
    const employeeId = Number(info.lastInsertRowid);

    db.prepare('UPDATE device_user_map SET employee_id = ? WHERE id = ?').run(employeeId, mapping.id);
    const backfill = db
      .prepare('UPDATE punches SET employee_id = ? WHERE device_id = ? AND device_user_id = ?')
      .run(employeeId, mapping.device_id, mapping.device_user_id);

    return { employeeId, backfilled: backfill.changes };
  });

  res.status(201).json({ ok: true, ...result, employee: getEmployee(result.employeeId) });
});

/**
 * Links every unmapped device user whose enrollment number matches an employee code.
 * The common case after enrolling the same staff on all three terminals.
 */
mappingsRouter.post('/auto-link', (req, res) => {
  const unmapped = db
    .prepare('SELECT * FROM device_user_map WHERE employee_id IS NULL')
    .all();

  const linked = transaction(() => {
    let count = 0;
    for (const mapping of unmapped) {
      const employee = db
        .prepare('SELECT id FROM employees WHERE code = ?')
        .get(mapping.device_user_id);
      if (!employee) continue;

      db.prepare('UPDATE device_user_map SET employee_id = ? WHERE id = ?').run(employee.id, mapping.id);
      db.prepare('UPDATE punches SET employee_id = ? WHERE device_id = ? AND device_user_id = ?')
        .run(employee.id, mapping.device_id, mapping.device_user_id);
      count += 1;
    }
    return count;
  });

  res.json({ ok: true, linked, remaining: unmapped.length - linked });
});
