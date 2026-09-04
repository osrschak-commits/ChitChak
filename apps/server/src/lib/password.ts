import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * `promisify(scrypt)` collapses the overloads and loses the options argument,
 * so the wrapper is written out by hand to keep `N`/`r`/`p`/`maxmem` typed.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * Password hashing with scrypt from Node's standard library.
 *
 * Deliberately not argon2/bcrypt: both are native addons that need a C++
 * toolchain to install, which is a recurring source of "works on my machine" on
 * Windows and in slim CI images. scrypt is memory-hard, in the standard
 * library, and at these parameters is a perfectly respectable choice.
 *
 * Parameters are stored in the hash string, so they can be raised later and old
 * hashes will still verify (and can be transparently upgraded on next login).
 */
const N = 32_768; // CPU/memory cost. ~100ms and ~32MB per hash.
const r = 8; // Block size.
const p = 1; // Parallelisation.
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
// scrypt needs roughly 128 * N * r bytes; Node's default maxmem (32MB) is just
// under what N=32768 requires, so raise it explicitly.
const MAX_MEM = 192 * N * r;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: MAX_MEM,
  });

  return ['scrypt', N, r, p, salt.toString('base64url'), derived.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const storedN = Number(parts[1]);
  const storedR = Number(parts[2]);
  const storedP = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64url');
  const expected = Buffer.from(parts[5] ?? '', 'base64url');

  if (!Number.isInteger(storedN) || !Number.isInteger(storedR) || !Number.isInteger(storedP)) return false;
  // Guard against a tampered hash string demanding absurd amounts of memory.
  if (storedN > 1 << 20 || storedR > 32 || storedP > 16) return false;
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
    N: storedN,
    r: storedR,
    p: storedP,
    maxmem: 192 * storedN * storedR,
  });

  return timingSafeEqual(derived, expected);
}

/** True when a stored hash used weaker parameters than we now require. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < N || Number(parts[2]) < r;
}

/**
 * Burn roughly the same time as a real verification would.
 *
 * Called when login is attempted against an address that has no account, so
 * that response timing does not reveal which addresses are registered.
 */
export async function fakeVerify(): Promise<void> {
  await scryptAsync('timing-equalisation', randomBytes(SALT_LENGTH), KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: MAX_MEM,
  });
}
