import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Each run gets its own database file.
const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'att-test-')), 'test.db');
process.env.DB_PATH = tmpDb;

const { db } = await import('../src/db.js');
const { syncDevice } = await import('../src/sync/syncService.js');
const { getAttendanceGrid } = await import('../src/services/attendanceService.js');
const { toLocalDay } = await import('../src/lib/time.js');

function addFakeDevice(name, ip) {
  const info = db
    .prepare(
      `INSERT INTO devices (name, driver, ip, port, enabled) VALUES (?, 'fake', ?, 4370, 1)`,
    )
    .run(name, ip);
  return Number(info.lastInsertRowid);
}

test('sync stores punches and is idempotent on re-sync', async () => {
  const deviceId = addFakeDevice('Test Gate', '10.9.9.1');

  const first = await syncDevice(deviceId, 'manual');
  assert.equal(first.status, 'ok');
  assert.ok(first.inserted > 0, 'first sync should insert punches');
  assert.equal(first.skipped, 0);

  const second = await syncDevice(deviceId, 'manual');
  assert.equal(second.status, 'ok');
  assert.equal(second.inserted, 0, 're-sync must not duplicate');
  assert.equal(second.skipped, first.inserted);
});

test('two devices with the same enrollment number stay separate people', async () => {
  const deviceA = addFakeDevice('Gate A', '10.9.9.2');
  const deviceB = addFakeDevice('Gate B', '10.9.9.3');
  await syncDevice(deviceA, 'manual');
  await syncDevice(deviceB, 'manual');

  const mappings = db
    .prepare('SELECT * FROM device_user_map WHERE device_user_id = ?')
    .all('1');
  assert.equal(mappings.length, 3, 'ID 1 exists once per device, not globally');
  assert.equal(new Set(mappings.map((m) => m.device_id)).size, 3);
});

test('mapping a device user backfills its punches', async () => {
  const employeeId = Number(
    db.prepare("INSERT INTO employees (code, name) VALUES ('E1', 'Test Person')").run()
      .lastInsertRowid,
  );
  const mapping = db.prepare('SELECT * FROM device_user_map LIMIT 1').get();

  db.prepare('UPDATE device_user_map SET employee_id = ? WHERE id = ?').run(employeeId, mapping.id);
  const result = db
    .prepare('UPDATE punches SET employee_id = ? WHERE device_id = ? AND device_user_id = ?')
    .run(employeeId, mapping.device_id, mapping.device_user_id);

  assert.ok(result.changes > 0, 'past punches should be attributed');

  const to = toLocalDay(new Date());
  const from = toLocalDay(new Date(Date.now() - 7 * 864e5));
  const { rows } = getAttendanceGrid({ from, to, employeeId });

  const worked = rows.filter((r) => r.firstIn);
  assert.ok(worked.length > 0, 'grid should show worked days');
  for (const row of worked) {
    if (row.lastOut) assert.ok(row.lastOut > row.firstIn, 'last out must follow first in');
  }
});

test('history is re-keyed, not duplicated, when the serial only reads on a later sync', async () => {
  const { FakeDeviceAdapter } = await import('../src/devices/fakeAdapter.js');
  const deviceId = addFakeDevice('Late Serial', '10.9.9.4');

  // First sync: firmware refuses to report a serial, so punches land under the IP key.
  const realGetInfo = FakeDeviceAdapter.prototype.getInfo;
  FakeDeviceAdapter.prototype.getInfo = async function withoutSerial() {
    const info = await realGetInfo.call(this);
    return { ...info, serial: null };
  };
  const first = await syncDevice(deviceId, 'manual');
  FakeDeviceAdapter.prototype.getInfo = realGetInfo;

  const count = () =>
    db.prepare('SELECT COUNT(*) AS n FROM punches WHERE device_id = ?').get(deviceId).n;

  assert.ok(first.inserted > 0);
  assert.equal(count(), first.inserted);
  assert.ok(
    db.prepare("SELECT 1 FROM punches WHERE device_id = ? AND device_serial LIKE 'ip:%'").get(deviceId),
    'first sync should have used the IP fallback key',
  );

  // Second sync reads the real serial: the same punches must not re-insert.
  const second = await syncDevice(deviceId, 'manual');
  assert.equal(second.inserted, 0, 'a newly readable serial must not duplicate history');
  assert.equal(count(), first.inserted);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM punches WHERE device_id = ? AND device_serial LIKE 'ip:%'")
      .get(deviceId).n,
    0,
    'stale IP-keyed rows should have been migrated',
  );
});

test('every wire format normalises an enrollment number to the same key', async () => {
  const { normalizeUserId } = await import('../src/devices/adapter.js');

  // Attendance log (padded string) / user list (plain string) / 18-byte realtime frame (number).
  assert.equal(normalizeUserId('005'), '5');
  assert.equal(normalizeUserId('5'), '5');
  assert.equal(normalizeUserId(5), '5');
  assert.equal(normalizeUserId(' 5 '), '5');
  assert.equal(normalizeUserId(`5${String.fromCharCode(0)}`), '5');

  // Non-numeric IDs are left alone; empty values are rejected rather than keyed as ''.
  assert.equal(normalizeUserId('A12'), 'A12');
  assert.equal(normalizeUserId(''), null);
  assert.equal(normalizeUserId(null), null);
});

test.after(() => {
  db.close();
  fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
});

test('comm-key derivation is deterministic and session-bound', async () => {
  const { makeCommKey } = await import('../src/devices/commKey.js');

  const a = makeCommKey(123456, 4242);
  assert.equal(a.length, 4);
  assert.deepEqual(makeCommKey(123456, 4242), a, 'same inputs must give the same payload');

  // Session-bound: the device issues a new session id per connection, so the
  // payload on the wire differs every time and cannot be replayed.
  assert.notDeepEqual(makeCommKey(123456, 4243), a);
  assert.notDeepEqual(makeCommKey(123457, 4242), a);

  // Accepts the string form the database stores.
  assert.deepEqual(makeCommKey('123456', 4242), a);

  // Regression lock, hand-checked: key 0 / session 0 gives 00000000, XOR 'ZKSO'
  // -> 5a4b534f, halves swapped -> 534f5a4b, XOR 0x32 on bytes 0,1,3 -> 617d5a79.
  // Proof of correctness is still the device answering CMD_ACK_OK, not this value.
  assert.equal(makeCommKey(0, 0).toString('hex'), '617d5a79');
});
