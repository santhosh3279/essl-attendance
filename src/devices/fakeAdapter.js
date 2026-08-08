import { DeviceAdapter } from './adapter.js';

const NAMES = [
  'Anitha R', 'Bharath K', 'Chitra M', 'Dinesh P', 'Elango S',
  'Fathima N', 'Ganesh V', 'Hema L', 'Irfan A', 'Jaya K',
  'Karthik S', 'Lakshmi D',
];

/** Deterministic PRNG so a given device always produces the same history. */
function seeded(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0xffffffff;
  };
}

const hash = (text) => {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/**
 * Synthetic device. Lets the whole app be exercised end to end without hardware:
 * same interface, same punch shape, same dedup behaviour (returns its full log
 * on every read, exactly like a real terminal).
 */
export class FakeDeviceAdapter extends DeviceAdapter {
  constructor(device) {
    super(device);
    this.connected = false;
    this.liveTimer = null;
    this.extraPunches = [];
    this.rand = seeded(hash(device.ip || device.name || 'fake'));
    this.userCount = 4 + Math.floor(this.rand() * 4);
  }

  get supportsLiveCapture() {
    return true;
  }

  get serial() {
    return `FAKE-${String(hash(this.device.ip || this.device.name)).slice(0, 8)}`;
  }

  async connect() {
    await new Promise((r) => setTimeout(r, 120));
    this.connected = true;
  }

  async disconnect() {
    this.connected = false;
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
  }

  async getInfo() {
    return {
      serial: this.serial,
      model: 'FAKE-K40',
      firmware: 'Ver 6.60 (simulated)',
      deviceTime: new Date(),
      userCount: this.userCount,
      logCount: this.getSyntheticPunches().length + this.extraPunches.length,
      logCapacity: 100000,
      connectionType: 'fake',
    };
  }

  async getUsers() {
    return Array.from({ length: this.userCount }, (_, i) => ({
      deviceUserId: String(1 + i),
      name: NAMES[i % NAMES.length],
      role: 0,
      cardNo: 0,
    }));
  }

  /** 7 days of punches: an in and an out per user per weekday, with jitter. */
  getSyntheticPunches() {
    const users = Array.from({ length: this.userCount }, (_, i) => String(1 + i));
    const rand = seeded(hash(this.device.ip || this.device.name) + 7);
    const punches = [];

    for (let dayBack = 6; dayBack >= 0; dayBack -= 1) {
      const day = new Date();
      day.setDate(day.getDate() - dayBack);
      day.setHours(0, 0, 0, 0);
      if (day.getDay() === 0) continue; // Sunday off

      for (const deviceUserId of users) {
        if (rand() < 0.08) continue; // absent

        const inTime = new Date(day);
        inTime.setHours(9, Math.floor(rand() * 40) - 10, Math.floor(rand() * 60));
        punches.push(this.makePunch(deviceUserId, inTime, 0));

        if (dayBack === 0 && new Date().getHours() < 18) continue; // still at work today

        const outTime = new Date(day);
        outTime.setHours(18, Math.floor(rand() * 50) - 15, Math.floor(rand() * 60));
        punches.push(this.makePunch(deviceUserId, outTime, 1));
      }
    }
    return punches;
  }

  makePunch(deviceUserId, time, type) {
    return { deviceUserId, time, rawTime: time.toString(), type, state: 1 };
  }

  async getAttendance() {
    await new Promise((r) => setTimeout(r, 150));
    return [...this.getSyntheticPunches(), ...this.extraPunches];
  }

  async setTime() {
    /* nothing to set on a simulated clock */
  }

  async startLiveCapture(onPunch) {
    this.liveTimer = setInterval(() => {
      const deviceUserId = String(1 + Math.floor(Math.random() * this.userCount));
      const punch = this.makePunch(deviceUserId, new Date(), Math.random() < 0.5 ? 0 : 1);
      this.extraPunches.push(punch);
      onPunch(punch);
    }, 20000);
  }

  async stopLiveCapture() {
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
  }
}
