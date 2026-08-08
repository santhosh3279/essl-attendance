import { Router } from 'express';
import { db } from '../db.js';
import { withDevice, isLive } from '../devices/registry.js';
import { applyLiveCaptureSetting } from '../sync/scheduler.js';
import { syncDevice } from '../sync/syncService.js';

export const devicesRouter = Router();

const getDevice = (id) => db.prepare('SELECT * FROM devices WHERE id = ?').get(Number(id));

/**
 * The comm key is a device credential and has to be stored in plaintext (it is
 * scrambled per-session at connect time, so it cannot be hashed). This is the
 * only place that keeps it out of reach — never spread the raw row to a client.
 */
const decorate = ({ comm_key: commKey, ...device }) => ({
  ...device,
  enabled: !!device.enabled,
  live_capture: !!device.live_capture,
  live_connected: isLive(device.id),
  has_comm_key: !!commKey,
});

function validate(body, { partial = false } = {}) {
  const errors = [];
  const required = (field) => !partial && (body[field] == null || body[field] === '');

  if (required('name')) errors.push('name is required');
  if (required('ip')) errors.push('ip is required');
  if (body.ip != null && !/^[\w.-]+$/.test(String(body.ip))) {
    errors.push('ip must be an IP address or hostname');
  }
  if (body.port != null && !(Number(body.port) > 0 && Number(body.port) < 65536)) {
    errors.push('port must be between 1 and 65535');
  }
  if (body.conn_mode != null && !['auto', 'tcp', 'udp'].includes(body.conn_mode)) {
    errors.push("conn_mode must be 'auto', 'tcp' or 'udp'");
  }
  if (body.driver != null && !['zk', 'fake'].includes(body.driver)) {
    errors.push("driver must be 'zk' or 'fake'");
  }
  return errors;
}

/** Blank means "no key"; anything else is stored as typed. */
function commKeyValue(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  return text === '' ? null : text;
}

/** Two devices cannot share a local UDP bind port — the second one gets EADDRINUSE. */
function inportClash(inport, excludeId = null) {
  if (!Number(inport)) return null;
  return db
    .prepare('SELECT name FROM devices WHERE inport = ? AND id IS NOT ?')
    .get(Number(inport), excludeId);
}

devicesRouter.get('/', (req, res) => {
  const devices = db.prepare('SELECT * FROM devices ORDER BY name').all();
  res.json(devices.map(decorate));
});

devicesRouter.post('/', (req, res) => {
  const errors = validate(req.body);
  const clash = inportClash(req.body.inport);
  if (clash) errors.push(`UDP local port ${req.body.inport} is already used by "${clash.name}"`);
  if (errors.length) return res.status(400).json({ errors });

  const info = db
    .prepare(
      `INSERT INTO devices (name, driver, ip, port, inport, conn_mode, comm_key, location, enabled, live_capture)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      req.body.name,
      req.body.driver || 'zk',
      req.body.ip,
      Number(req.body.port) || 4370,
      Number(req.body.inport) || 0,
      req.body.conn_mode || 'auto',
      commKeyValue(req.body.comm_key),
      req.body.location || null,
      req.body.enabled === false ? 0 : 1,
      req.body.live_capture ? 1 : 0,
    );

  // The local UDP bind port must be unique per device: two devices syncing in
  // parallel on the same one collide with EADDRINUSE.
  if (!Number(req.body.inport)) {
    db.prepare('UPDATE devices SET inport = 5200 + id WHERE id = ?').run(info.lastInsertRowid);
  }

  const device = getDevice(info.lastInsertRowid);
  applyLiveCaptureSetting(device).catch(() => {});
  res.status(201).json(decorate(device));
});

devicesRouter.put('/:id', async (req, res) => {
  const existing = getDevice(req.params.id);
  if (!existing) return res.status(404).json({ error: 'device not found' });

  const errors = validate(req.body, { partial: true });
  const clash = inportClash(req.body.inport, existing.id);
  if (clash) errors.push(`UDP local port ${req.body.inport} is already used by "${clash.name}"`);
  if (errors.length) return res.status(400).json({ errors });

  const next = {
    name: req.body.name ?? existing.name,
    driver: req.body.driver ?? existing.driver,
    ip: req.body.ip ?? existing.ip,
    port: Number(req.body.port ?? existing.port),
    inport: Number(req.body.inport) || existing.inport || 5200 + existing.id,
    conn_mode: req.body.conn_mode ?? existing.conn_mode,
    location: req.body.location ?? existing.location,
    enabled: req.body.enabled == null ? existing.enabled : Number(!!req.body.enabled),
    live_capture:
      req.body.live_capture == null ? existing.live_capture : Number(!!req.body.live_capture),
    // Absent field keeps the saved key; an explicit empty string clears it.
    comm_key:
      req.body.comm_key === undefined ? existing.comm_key : commKeyValue(req.body.comm_key),
  };

  db.prepare(
    `UPDATE devices SET name = ?, driver = ?, ip = ?, port = ?, inport = ?,
            conn_mode = ?, comm_key = ?, location = ?, enabled = ?, live_capture = ?
      WHERE id = ?`,
  ).run(
    next.name, next.driver, next.ip, next.port, next.inport,
    next.conn_mode, next.comm_key, next.location, next.enabled, next.live_capture, existing.id,
  );

  const device = getDevice(existing.id);
  await applyLiveCaptureSetting(device).catch(() => {});
  res.json(decorate(device));
});

devicesRouter.delete('/:id', async (req, res) => {
  const device = getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: 'device not found' });

  // Punches survive: device_id becomes NULL but device_serial keeps the history intact.
  await applyLiveCaptureSetting({ ...device, enabled: 0, live_capture: 0 }).catch(() => {});
  db.prepare('DELETE FROM devices WHERE id = ?').run(device.id);
  res.json({ ok: true });
});

devicesRouter.post('/:id/test', async (req, res) => {
  const device = getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: 'device not found' });

  try {
    const info = await withDevice(device, (adapter) => adapter.getInfo());
    db.prepare(
      `UPDATE devices SET serial = COALESCE(?, serial), model = COALESCE(?, model),
              firmware = COALESCE(?, firmware), last_status = 'ok', last_error = NULL
        WHERE id = ?`,
    ).run(info.serial ?? null, info.model ?? null, info.firmware ?? null, device.id);

    res.json({ ok: true, info });
  } catch (err) {
    const message = err?.message || String(err);
    db.prepare("UPDATE devices SET last_status = 'error', last_error = ? WHERE id = ?").run(
      message,
      device.id,
    );
    res.status(502).json({ ok: false, error: message });
  }
});

devicesRouter.post('/:id/sync', async (req, res) => {
  const device = getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: 'device not found' });
  const result = await syncDevice(device.id, 'manual');
  res.status(result.status === 'ok' ? 200 : 502).json(result);
});

devicesRouter.post('/:id/clock-sync', async (req, res) => {
  const device = getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: 'device not found' });

  try {
    const result = await withDevice(device, async (adapter) => {
      const before = await adapter.getInfo().catch(() => ({}));
      const serverTime = new Date();
      await adapter.setTime(serverTime);
      return { deviceTimeBefore: before.deviceTime, serverTime };
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ ok: false, error: err?.message || String(err) });
  }
});

devicesRouter.get('/:id/users', (req, res) => {
  const rows = db
    .prepare(
      `SELECT m.id, m.device_user_id, m.device_user_name, m.employee_id,
              e.name AS employee_name, e.code AS employee_code
         FROM device_user_map m
         LEFT JOIN employees e ON e.id = m.employee_id
        WHERE m.device_id = ?
        ORDER BY CAST(m.device_user_id AS INTEGER)`,
    )
    .all(Number(req.params.id));
  res.json(rows);
});
