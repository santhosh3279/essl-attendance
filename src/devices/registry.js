import { ZkDeviceAdapter } from './zkAdapter.js';
import { FakeDeviceAdapter } from './fakeAdapter.js';

/**
 * ZK terminals accept ONE session at a time. Every access therefore goes through
 * a per-device promise chain, so two syncs (or a sync and a live-capture session)
 * can never hold the socket at once.
 */
const queues = new Map(); // deviceId -> tail of the promise chain
const liveSessions = new Map(); // deviceId -> adapter currently streaming

let livePunchHandler = null;

/** Wired up by the sync service at boot to avoid a circular import. */
export function setLivePunchHandler(handler) {
  livePunchHandler = handler;
}

export function createAdapter(device) {
  return device.driver === 'fake'
    ? new FakeDeviceAdapter(device)
    : new ZkDeviceAdapter(device);
}

export function isLive(deviceId) {
  return liveSessions.has(deviceId);
}

export function liveDeviceIds() {
  return [...liveSessions.keys()];
}

async function teardownLive(deviceId) {
  const adapter = liveSessions.get(deviceId);
  if (!adapter) return false;
  liveSessions.delete(deviceId);
  await adapter.stopLiveCapture().catch(() => {});
  await adapter.disconnect().catch(() => {});
  return true;
}

async function spawnLive(device) {
  if (liveSessions.has(device.id)) return;
  const adapter = createAdapter(device);
  await adapter.connect();
  await adapter.startLiveCapture((punch) => {
    if (livePunchHandler) livePunchHandler(device, punch);
  });
  liveSessions.set(device.id, adapter);
}

/**
 * Runs `fn(adapter)` with an exclusive, connected session on `device`.
 * Any live-capture stream is paused for the duration and resumed afterwards.
 */
export function withDevice(device, fn) {
  const previous = queues.get(device.id) ?? Promise.resolve();

  const task = previous.catch(() => {}).then(async () => {
    const hadLive = await teardownLive(device.id);
    const adapter = createAdapter(device);
    try {
      await adapter.connect();
      return await fn(adapter);
    } finally {
      await adapter.disconnect().catch(() => {});
      if (hadLive || device.live_capture) {
        await spawnLive(device).catch((err) => {
          console.error(`[live] could not resume on ${device.name}: ${err.message}`);
        });
      }
    }
  });

  queues.set(device.id, task);
  return task;
}

/** Start streaming punches from `device`, queued behind any running job. */
export function startLiveCapture(device) {
  const previous = queues.get(device.id) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => spawnLive(device));
  queues.set(device.id, task);
  return task;
}

export function stopLiveCapture(deviceId) {
  const previous = queues.get(deviceId) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => teardownLive(deviceId));
  queues.set(deviceId, task);
  return task;
}

export async function stopAllLiveCapture() {
  await Promise.allSettled([...liveSessions.keys()].map((id) => teardownLive(id)));
}
