import * as argon2 from 'argon2';

/**
 * Password hashing uses Argon2id (spec §9.1). Single source of truth for
 * parameters — do not call argon2 directly from services.
 *
 * Tuning targets ≥100 ms per hash on a 2-core VPS (OWASP 2024 guidance):
 *   memoryCost = 2^16 KiB (64 MiB), timeCost = 3, parallelism = 1.
 * If you tune these up, users created under the old params still verify
 * because argon2.verify reads params from the encoded hash.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 1 << 16,
  timeCost: 3,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(
  hash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // Malformed hash or Argon2 internal error — treat as failed match rather
    // than a 500. Prevents login from throwing on historical/legacy rows.
    return false;
  }
}
