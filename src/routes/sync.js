import { Router } from 'express';
import { db } from '../db.js';
import { syncAllDevices } from '../sync/syncService.js';
import { bus } from '../lib/events.js';
import { sessionStillValid } from '../auth/sessions.js';

export const syncRouter = Router();

syncRouter.post('/sync', async (req, res) => {
  const results = await syncAllDevices('manual');
  res.json({
    ok: results.every((r) => r.status === 'ok'),
    results,
  });
});

syncRouter.get('/sync-logs', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const rows = db
    .prepare(
      `SELECT s.*, d.name AS device_name
         FROM sync_logs s
         LEFT JOIN devices d ON d.id = s.device_id
        ORDER BY s.id DESC
        LIMIT ?`,
    )
    .all(limit);
  res.json(rows);
});

/** Server-Sent Events: live punches and sync results pushed to the browser. */
syncRouter.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');

  const send = (event) => (payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const onPunch = send('punch');
  const onSync = send('sync');

  bus.on('punch', onPunch);
  bus.on('sync', onSync);

  const stop = () => {
    clearInterval(heartbeat);
    bus.off('punch', onPunch);
    bus.off('sync', onSync);
  };

  // A long-lived stream would keep pushing punch data after the session expired
  // or was revoked, so re-check it on every heartbeat.
  const tokenHash = req.user.tokenHash;
  const heartbeat = setInterval(() => {
    if (!sessionStillValid(tokenHash)) {
      stop();
      res.end();
      return;
    }
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', stop);
});
