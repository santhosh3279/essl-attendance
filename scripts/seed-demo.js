/**
 * Fills the database with three simulated terminals, a staff list and a week of
 * punches, so the whole UI can be exercised before the real hardware is wired up.
 * Safe to re-run: everything is upserted or deduplicated.
 */
import { db } from '../src/db.js';
import { syncDevice } from '../src/sync/syncService.js';

const DEVICES = [
  { name: 'Main Gate', ip: '10.0.0.201', location: 'Factory entrance' },
  { name: 'Office Floor', ip: '10.0.0.202', location: 'First floor lobby' },
  { name: 'Warehouse', ip: '10.0.0.203', location: 'Loading bay' },
];

const EMPLOYEES = [
  ['1', 'Anitha R', 'Production'],
  ['2', 'Bharath K', 'Production'],
  ['3', 'Chitra M', 'Quality'],
  ['4', 'Dinesh P', 'Warehouse'],
  ['5', 'Elango S', 'Warehouse'],
  ['6', 'Fathima N', 'Accounts'],
  ['7', 'Ganesh V', 'Production'],
  ['8', 'Hema L', 'Accounts'],
  ['9', 'Irfan A', 'Quality'],
  ['10', 'Jaya K', 'Admin'],
  ['11', 'Karthik S', 'Admin'],
  ['12', 'Lakshmi D', 'Production'],
];

for (const [code, name, department] of EMPLOYEES) {
  db.prepare(
    `INSERT INTO employees (code, name, department) VALUES (?, ?, ?)
     ON CONFLICT (code) DO UPDATE SET name = excluded.name, department = excluded.department`,
  ).run(code, name, department);
}
console.log(`employees: ${EMPLOYEES.length}`);

const deviceIds = [];
for (const device of DEVICES) {
  const existing = db.prepare('SELECT id FROM devices WHERE ip = ?').get(device.ip);
  if (existing) {
    deviceIds.push(existing.id);
    continue;
  }
  const info = db
    .prepare(
      `INSERT INTO devices (name, driver, ip, port, location, enabled, live_capture)
       VALUES (?, 'fake', ?, 4370, ?, 1, 0)`,
    )
    .run(device.name, device.ip, device.location);

  // Each device needs its own local UDP bind port, same as the real ones.
  db.prepare('UPDATE devices SET inport = 5200 + id WHERE id = ?').run(info.lastInsertRowid);
  deviceIds.push(Number(info.lastInsertRowid));
}
console.log(`devices: ${deviceIds.length} (driver=fake)`);

for (const deviceId of deviceIds) {
  const result = await syncDevice(deviceId, 'manual');
  console.log(
    `sync ${result.deviceName}: ${result.status} — fetched ${result.fetched ?? 0}, new ${result.inserted ?? 0}` +
      (result.error ? ` (${result.error})` : ''),
  );
}

// Enrollment numbers on the simulated devices match the employee codes.
let linked = 0;
for (const mapping of db.prepare('SELECT * FROM device_user_map WHERE employee_id IS NULL').all()) {
  const employee = db.prepare('SELECT id FROM employees WHERE code = ?').get(mapping.device_user_id);
  if (!employee) continue;
  db.prepare('UPDATE device_user_map SET employee_id = ? WHERE id = ?').run(employee.id, mapping.id);
  db.prepare('UPDATE punches SET employee_id = ? WHERE device_id = ? AND device_user_id = ?')
    .run(employee.id, mapping.device_id, mapping.device_user_id);
  linked += 1;
}
console.log(`mapped ${linked} device users to employees`);

const punches = db.prepare('SELECT COUNT(*) AS n FROM punches').get().n;
const unmapped = db.prepare('SELECT COUNT(*) AS n FROM punches WHERE employee_id IS NULL').get().n;
console.log(`punches: ${punches} (${unmapped} unattributed)`);
console.log('\ndone — run `npm start` and open http://localhost:3000');

db.close();
process.exit(0);
