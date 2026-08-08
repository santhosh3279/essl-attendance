import ZKLib from 'zkteco-js';
import { DeviceAdapter, normalizeUserId } from './adapter.js';
import { config } from '../config.js';
import { parseDeviceTime } from '../lib/time.js';
import {
  CMD_ACK_OK,
  CMD_ACK_UNAUTH,
  CMD_AUTH,
  CMD_CONNECT,
  describeAck,
  makeCommKey,
  replyCommandId,
} from './commKey.js';

const NULLS = /\u0000/g;

/** Serials arrive space/null padded and are compared exactly, so strip both. */
const cleanSerial = (value) =>
  typeof value === 'string' ? value.replace(NULLS, '').replace(/\s/g, '') : value;

/** Names, models and firmware are human-readable — strip padding, keep inner spaces. */
const cleanText = (value) =>
  typeof value === 'string' ? value.replace(NULLS, '').trim() : value;

/** Real ESSL / ZKTeco hardware, over the ZK protocol (TCP 4370, UDP fallback). */
export class ZkDeviceAdapter extends DeviceAdapter {
  constructor(device) {
    super(device);
    this.zk = null;
    this.liveActive = false;
  }

  get supportsLiveCapture() {
    return true;
  }

  async connect() {
    if (this.zk) return;
    const zk = new ZKLib(
      this.device.ip,
      this.device.port || 4370,
      config.deviceTimeoutMs,
      // The local UDP bind port. Two devices sharing it collide with EADDRINUSE,
      // so each device gets its own (assigned on creation).
      this.device.inport || 5200,
    );

    const mode = this.device.conn_mode || 'auto';
    try {
      if (mode === 'udp') {
        // createSocket() only reaches UDP when TCP is actively refused, so force it here.
        await zk.zudp.createSocket();
        await this.handshake(zk.zudp);
        zk.connectionType = 'udp';
      } else {
        await zk.ztcp.createSocket();
        await this.handshake(zk.ztcp);
        zk.connectionType = 'tcp';
      }
    } catch (err) {
      await zk.disconnect().catch(() => {});
      throw err;
    }
    this.zk = zk;
  }

  /**
   * Opens the session properly, which the library does not: its connect() takes
   * ANY reply as success, so a terminal with a comm key set reports "connected"
   * and then fails every subsequent command in a way that looks like a timeout.
   */
  async handshake(transport) {
    const connectReply = await transport.executeCmd(CMD_CONNECT, '');
    let ack = replyCommandId(connectReply);

    if (ack === CMD_ACK_UNAUTH) {
      const commKey = this.device.comm_key;
      if (commKey == null || commKey === '') {
        throw new Error(
          'device requires a comm key — set it on the device in this app (Devices → Edit → Comm key)',
        );
      }

      // The payload mixes the key with the session id the device just issued.
      const payload = makeCommKey(commKey, transport.sessionId);
      ack = replyCommandId(await transport.executeCmd(CMD_AUTH, payload));

      if (ack !== CMD_ACK_OK) {
        throw new Error(`device rejected the comm key (${describeAck(ack)})`);
      }
      return;
    }

    if (ack !== CMD_ACK_OK) {
      throw new Error(`device refused the connection (${describeAck(ack)})`);
    }
  }

  async disconnect() {
    if (!this.zk) return;
    const zk = this.zk;
    this.zk = null;
    this.liveActive = false;
    try {
      await zk.disconnect();
    } catch {
      /* the socket may already be gone; nothing useful to do */
    }
  }

  async getInfo() {
    const info = await this.zk.getInfo().catch(() => ({}));
    // Every field below is optional on older firmware, so failures degrade instead of throwing.
    const [serial, model, firmware] = await Promise.all([
      this.zk.getSerialNumber().catch(() => null),
      this.zk.getDeviceName().catch(() => null),
      this.zk.getFirmware().catch(() => null),
    ]);
    const deviceTime = await this.zk.getTime().catch(() => null);

    return {
      serial: cleanSerial(serial) || null,
      model: cleanText(model) || null,
      firmware: cleanText(firmware) || null,
      deviceTime: deviceTime instanceof Date ? deviceTime : null,
      userCount: info.userCounts ?? null,
      logCount: info.logCounts ?? null,
      logCapacity: info.logCapacity ?? null,
      connectionType: this.zk.connectionType,
    };
  }

  async getUsers() {
    const result = await this.zk.getUsers();
    const rows = result?.data ?? [];
    return rows.map((user) => ({
      // userId is the number the employee is enrolled under; uid is internal storage.
      deviceUserId: normalizeUserId(user.userId) ?? normalizeUserId(user.uid),
      name: cleanText(user.name) || null,
      role: user.role ?? null,
      cardNo: user.cardno ?? null,
    }));
  }

  async getAttendance() {
    const result = await this.zk.getAttendances();
    const rows = result?.data ?? [];
    const punches = [];
    for (const row of rows) {
      const time = parseDeviceTime(row.record_time);
      const deviceUserId = normalizeUserId(row.user_id);
      if (!time || !deviceUserId) continue;
      punches.push({
        deviceUserId,
        time,
        rawTime: String(row.record_time),
        type: row.type ?? null,
        state: row.state ?? null,
      });
    }
    return punches;
  }

  async setTime(date = new Date()) {
    await this.zk.setTime(date);
  }

  async startLiveCapture(onPunch) {
    await this.zk.getRealTimeLogs((log) => {
      const time = parseDeviceTime(log?.attTime);
      // The 18-byte realtime frame decodes userId as a number, the 52-byte one as a
      // string — normalizeUserId makes both match what the poll path stores.
      const deviceUserId = normalizeUserId(log?.userId);
      if (!time || !deviceUserId) return;
      onPunch({ deviceUserId, time, rawTime: String(log.attTime), type: null, state: null });
    });
    this.liveActive = true;
  }

  async stopLiveCapture() {
    // The protocol has no "unregister event" — the session has to be torn down.
    this.liveActive = false;
    await this.disconnect();
  }
}
