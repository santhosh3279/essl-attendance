/**
 * ZK comm-key ("device password") authentication.
 *
 * zkteco-js defines CMD_AUTH but never sends it, and its connect() treats any
 * reply as success — so a terminal with a comm key set answers CMD_ACK_UNAUTH,
 * the library reports "connection successful", and every later command talks to
 * a session the device already refused.
 */

export const CMD_CONNECT = 1000;
export const CMD_AUTH = 1102;
export const CMD_ACK_OK = 2000;
export const CMD_ACK_ERROR = 2001;
export const CMD_ACK_UNAUTH = 2005;

/**
 * Scrambles the comm key together with the session id the device just issued,
 * so the payload is different on every connection and cannot be replayed.
 *
 * Ported from pyzk's make_commkey, itself a port of MakeKey in commpro.c.
 * `ticks` is a constant in every implementation of this that works.
 */
export function makeCommKey(key, sessionId, ticks = 50) {
  const value = Number(key) >>> 0;
  let scrambled = 0;

  // Reverse the bit order of the key.
  for (let i = 0; i < 32; i += 1) {
    scrambled = value & (1 << i) ? ((scrambled << 1) | 1) >>> 0 : (scrambled << 1) >>> 0;
  }
  scrambled = (scrambled + Number(sessionId)) >>> 0;

  const packed = Buffer.alloc(4);
  packed.writeUInt32LE(scrambled, 0);
  packed[0] ^= 'Z'.charCodeAt(0);
  packed[1] ^= 'K'.charCodeAt(0);
  packed[2] ^= 'S'.charCodeAt(0);
  packed[3] ^= 'O'.charCodeAt(0);

  // Swap the two 16-bit halves.
  const swapped = Buffer.alloc(4);
  swapped.writeUInt16LE(packed.readUInt16LE(2), 0);
  swapped.writeUInt16LE(packed.readUInt16LE(0), 2);

  const mask = ticks & 0xff;
  swapped[0] ^= mask;
  swapped[1] ^= mask;
  swapped[3] ^= mask;
  return swapped;
}

/** Command id from a reply body, for both the TCP and UDP transports. */
export function replyCommandId(body) {
  return Buffer.isBuffer(body) && body.length >= 2 ? body.readUInt16LE(0) : null;
}

export function describeAck(commandId) {
  return (
    { [CMD_ACK_OK]: 'OK', [CMD_ACK_ERROR]: 'ERROR', [CMD_ACK_UNAUTH]: 'UNAUTHORISED' }[commandId] ??
    `unknown (${commandId})`
  );
}
