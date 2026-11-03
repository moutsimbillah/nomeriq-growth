import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

/** Lowest password length any entry point allows. Callers enforce their own policy:
 *  setup and team creation require 10, change-password allows 8. This guard exists
 *  only so a caller that forgets cannot hash something trivially short. */
export const PASSWORD_HARD_MIN_LENGTH = 8;

export function hashPassword(password: string): string {
  if (password.length < PASSWORD_HARD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_HARD_MIN_LENGTH} characters.`);
  }
  const salt = randomBytes(16).toString("base64");
  const hash = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }).toString("base64");
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, salt, expectedRaw] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }
  try {
    const actual = scryptSync(password, salt, KEY_LENGTH, { N: n, r, p });
    const expected = Buffer.from(expectedRaw, "base64");
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
