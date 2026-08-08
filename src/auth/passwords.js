import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// Stored as scrypt$N$r$p$salt$hash so the parameters can be raised later
// without invalidating existing passwords.
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
  });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;

  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = await scrypt(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    // timingSafeEqual throws on a length mismatch, so check that first.
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Burns roughly the same time as a real verification. Called when the username
 * does not exist, so response timing does not reveal which accounts are real.
 */
export async function fakeVerify() {
  await scrypt('no-such-user', 'no-such-salt', PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
  });
  return false;
}

export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'password must be at least 8 characters';
  }
  if (password.length > 200) return 'password is too long';
  return null;
}
