import { EventEmitter } from 'node:events';

/**
 * App-wide bus. The HTTP layer turns these into a Server-Sent Events stream so
 * the browser updates without polling.
 *   'punch'  { deviceId, deviceName, deviceUserId, employeeName, punchLocal, source }
 *   'sync'   { deviceId, status, inserted, fetched, error }
 *   'device' { deviceId, state }
 */
export const bus = new EventEmitter();
bus.setMaxListeners(50);
