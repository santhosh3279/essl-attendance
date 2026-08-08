import { db } from '../db.js';
import { config } from '../config.js';
import { syncAllDevices } from './syncService.js';
import { startLiveCapture, stopLiveCapture } from '../devices/registry.js';

let timer = null;
let running = false;

async function tick() {
  if (running) {
    console.warn('[scheduler] previous poll still running, skipping this tick');
    return;
  }
  running = true;
  try {
    await syncAllDevices('scheduled');
  } catch (err) {
    console.error(`[scheduler] poll failed: ${err.message}`);
  } finally {
    running = false;
  }
}

export function startScheduler() {
  if (config.pollIntervalMinutes <= 0) {
    console.log('[scheduler] disabled (POLL_INTERVAL_MINUTES=0)');
    return;
  }
  const intervalMs = config.pollIntervalMinutes * 60_000;
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  console.log(`[scheduler] polling every ${config.pollIntervalMinutes} min`);
  // First pass shortly after boot, once the HTTP server is already answering.
  setTimeout(tick, 5000).unref?.();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Opens live streams for every enabled device that has live capture switched on. */
export async function startConfiguredLiveCapture() {
  const devices = db
    .prepare('SELECT * FROM devices WHERE enabled = 1 AND live_capture = 1')
    .all();
  for (const device of devices) {
    startLiveCapture(device).catch((err) =>
      console.error(`[live] ${device.name}: ${err.message}`),
    );
  }
}

export async function applyLiveCaptureSetting(device) {
  if (device.enabled && device.live_capture) await startLiveCapture(device);
  else await stopLiveCapture(device.id);
}
