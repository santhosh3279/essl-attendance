const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD HH:MM:SS' in the server's local timezone. */
export function toLocalStamp(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 'YYYY-MM-DD' in the server's local timezone. */
export function toLocalDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Devices report wall-clock time with no timezone. The library decodes it with
 * `new Date(y, m, d, ...)`, i.e. in the server's local zone, so the device and
 * the server must agree on the timezone — that is what "sync device clock" is for.
 */
export function parseDeviceTime(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function minutesBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 60000;
}

/** '07:35' from a 'YYYY-MM-DD HH:MM:SS' stamp. */
export function timeOnly(stamp) {
  return stamp ? stamp.slice(11, 16) : null;
}
