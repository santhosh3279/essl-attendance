/**
 * DeviceAdapter contract. Every driver ('zk', 'fake') implements exactly this,
 * so the sync service, routes and UI never touch the hardware library directly.
 *
 *   connect()                  -> void            open a session (one at a time per device)
 *   disconnect()               -> void            always safe to call, even if not connected
 *   getInfo()                  -> { serial, model, firmware, deviceTime, userCount, logCount }
 *   getUsers()                 -> [{ deviceUserId, name, role, cardNo }]
 *   getAttendance()            -> [Punch]
 *   setTime(date)              -> void            push the server clock onto the device
 *   startLiveCapture(onPunch)  -> void            optional; push punches as they happen
 *   stopLiveCapture()          -> void
 *
 * Punch = {
 *   deviceUserId: string,
 *   time:         Date,     // device wall-clock, read in the server timezone
 *   rawTime:      string,   // untouched value from the device
 *   type:         number|null,
 *   state:        number|null,
 * }
 */

/**
 * Enrollment numbers reach us in three shapes depending on the wire format:
 * a padded string from the attendance log, a plain string from the user list,
 * and a raw integer from the 18-byte realtime frame. They all key the same
 * `device_user_map` row, so every path must normalise identically or one person
 * turns into two mappings.
 */
export function normalizeUserId(value) {
  if (value == null) return null;
  const text = String(value).replace(/[\u0000\s]/g, '');
  if (!text) return null;
  // '005' and 5 are the same enrolment number.
  return /^\d+$/.test(text) ? String(Number(text)) : text;
}

export class DeviceAdapter {
  constructor(device) {
    this.device = device;
  }

  // eslint-disable-next-line class-methods-use-this
  get supportsLiveCapture() {
    return false;
  }

  async connect() {
    throw new Error('connect() not implemented');
  }

  async disconnect() {
    throw new Error('disconnect() not implemented');
  }

  async getInfo() {
    throw new Error('getInfo() not implemented');
  }

  async getUsers() {
    throw new Error('getUsers() not implemented');
  }

  async getAttendance() {
    throw new Error('getAttendance() not implemented');
  }

  async setTime() {
    throw new Error('setTime() not implemented');
  }

  async startLiveCapture() {
    throw new Error('live capture not supported by this driver');
  }

  async stopLiveCapture() {
    /* no-op by default */
  }
}
