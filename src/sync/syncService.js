import { db, transaction } from '../db.js';
import { withDevice, setLivePunchHandler } from '../devices/registry.js';
import { bus } from '../lib/events.js';
import { toLocalStamp, toLocalDay } from '../lib/time.js';

const insertPunch = db.prepare(`
  INSERT OR IGNORE INTO punches
    (device_id, device_serial, device_user_id, employee_id,
     punch_local, punch_day, punch_utc, punch_type, punch_state, raw_time, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMapping = db.prepare(`
  INSERT INTO device_user_map (device_id, device_user_id, device_user_name)
  VALUES (?, ?, ?)
  ON CONFLICT (device_id, device_user_id)
  DO UPDATE SET device_user_name = COALESCE(excluded.device_user_name, device_user_name)
`);

const findEmployeeId = db.prepare(
  'SELECT employee_id FROM device_user_map WHERE device_id = ? AND device_user_id = ?',
);

const insertSyncLog = db.prepare(`
  INSERT INTO sync_logs
    (device_id, trigger, status, fetched, inserted, skipped, new_users, duration_ms, error, started_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const touchDevice = db.prepare(`
  UPDATE devices
     SET serial = COALESCE(?, serial), model = COALESCE(?, model), firmware = COALESCE(?, firmware),
         last_sync_at = datetime('now'), last_status = ?, last_error = ?
   WHERE id = ?
`);

/** Falls back to the IP so a device that hides its serial still dedups consistently. */
function serialFor(device, info) {
  return info?.serial || device.serial || `ip:${device.ip}:${device.port}`;
}

/**
 * Re-keys history when a device's real serial only becomes readable later (older
 * firmware, or punches captured live before the first successful sync). Without
 * this the dedup key changes underneath the data and the whole log re-inserts.
 */
function migrateSerial(deviceId, serial) {
  const stale = db
    .prepare('SELECT 1 FROM punches WHERE device_id = ? AND device_serial != ? LIMIT 1')
    .get(deviceId, serial);
  if (!stale) return 0;

  return transaction(() => {
    // OR IGNORE: a punch already stored under the real serial wins; its stale twin
    // is deleted below rather than left as a duplicate.
    const moved = db
      .prepare(
        'UPDATE OR IGNORE punches SET device_serial = ? WHERE device_id = ? AND device_serial != ?',
      )
      .run(serial, deviceId, serial);
    db.prepare('DELETE FROM punches WHERE device_id = ? AND device_serial != ?')
      .run(deviceId, serial);
    return moved.changes;
  });
}

/**
 * Writes punches idempotently. Devices return their whole log on every read, so
 * re-inserts are expected and silently ignored by the unique index.
 */
function storePunches(device, deviceSerial, punches, source) {
  let inserted = 0;
  let skipped = 0;

  transaction(() => {
    for (const punch of punches) {
      const employee = findEmployeeId.get(device.id, punch.deviceUserId);
      if (!employee) insertMapping.run(device.id, punch.deviceUserId, null);

      const result = insertPunch.run(
        device.id,
        deviceSerial,
        punch.deviceUserId,
        employee?.employee_id ?? null,
        toLocalStamp(punch.time),
        toLocalDay(punch.time),
        punch.time.toISOString(),
        punch.type ?? null,
        punch.state ?? null,
        punch.rawTime ?? null,
        source,
      );
      if (result.changes > 0) inserted += 1;
      else skipped += 1;
    }
  });

  return { inserted, skipped };
}

/** Records device users so unknown enrollment numbers show up for mapping. */
function storeUsers(device, users) {
  let newUsers = 0;
  transaction(() => {
    for (const user of users) {
      const existing = findEmployeeId.get(device.id, user.deviceUserId);
      insertMapping.run(device.id, user.deviceUserId, user.name);
      if (!existing) newUsers += 1;
    }
  });
  return newUsers;
}

export async function syncDevice(deviceId, trigger = 'manual') {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device) throw new Error(`device ${deviceId} not found`);

  const startedAt = new Date();
  const startedStamp = toLocalStamp(startedAt);

  try {
    const result = await withDevice(device, async (adapter) => {
      const info = await adapter.getInfo().catch(() => ({}));
      const deviceSerial = serialFor(device, info);
      const users = await adapter.getUsers().catch(() => []);
      const punches = await adapter.getAttendance();
      return { info, deviceSerial, users, punches };
    });

    // Do this before storing, so the incoming batch dedups against the migrated rows.
    if (result.info.serial) migrateSerial(device.id, result.deviceSerial);

    const newUsers = storeUsers(device, result.users);
    const { inserted, skipped } = storePunches(
      device,
      result.deviceSerial,
      result.punches,
      'poll',
    );

    touchDevice.run(
      result.info.serial ?? null,
      result.info.model ?? null,
      result.info.firmware ?? null,
      'ok',
      null,
      device.id,
    );

    const summary = {
      deviceId: device.id,
      deviceName: device.name,
      status: 'ok',
      fetched: result.punches.length,
      inserted,
      skipped,
      newUsers,
      durationMs: Date.now() - startedAt.getTime(),
    };

    insertSyncLog.run(
      device.id, trigger, 'ok', summary.fetched, inserted, skipped, newUsers,
      summary.durationMs, null, startedStamp,
    );
    bus.emit('sync', summary);
    return summary;
  } catch (err) {
    const message = err?.message || String(err);
    touchDevice.run(null, null, null, 'error', message, device.id);
    insertSyncLog.run(
      device.id, trigger, 'error', 0, 0, 0, 0,
      Date.now() - startedAt.getTime(), message, startedStamp,
    );
    const summary = {
      deviceId: device.id,
      deviceName: device.name,
      status: 'error',
      error: message,
    };
    bus.emit('sync', summary);
    return summary;
  }
}

/** Syncs every enabled device. Devices run in parallel; each device is serialised internally. */
export async function syncAllDevices(trigger = 'scheduled') {
  const devices = db.prepare('SELECT id FROM devices WHERE enabled = 1').all();
  const results = await Promise.all(devices.map((d) => syncDevice(d.id, trigger)));
  return results;
}

/** Handles a punch pushed by a device in real time. */
function onLivePunch(liveDevice, punch) {
  try {
    // Re-read: the serial may have been learned by a sync after the stream started,
    // and the dedup key must match what the poll path writes.
    const device =
      db.prepare('SELECT * FROM devices WHERE id = ?').get(liveDevice.id) ?? liveDevice;
    const deviceSerial = serialFor(device, null);
    storePunches(device, deviceSerial, [punch], 'live');
    const mapping = findEmployeeId.get(device.id, punch.deviceUserId);
    const employee = mapping?.employee_id
      ? db.prepare('SELECT name FROM employees WHERE id = ?').get(mapping.employee_id)
      : null;

    bus.emit('punch', {
      deviceId: device.id,
      deviceName: device.name,
      deviceUserId: punch.deviceUserId,
      employeeName: employee?.name ?? null,
      punchLocal: toLocalStamp(punch.time),
      source: 'live',
    });
  } catch (err) {
    console.error(`[live] could not store punch from ${device.name}: ${err.message}`);
  }
}

setLivePunchHandler(onLivePunch);
