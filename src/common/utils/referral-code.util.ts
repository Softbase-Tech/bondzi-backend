import { randomBytes } from 'crypto';

/**
 * Referral-code generator shared by student and partner referral
 * systems. Seven uppercase alphanumeric characters, no separators,
 * layout `<4 hex><3 alpha>`.
 *
 * Examples:
 *   generateReferralCode('Kwame Asamoah') // "A1B2CKWA"
 *   generateReferralCode('')              // "A1B2GHN" (padded)
 *
 * Uniqueness across the two lookup tables (users.referral_code AND
 * partner_referral_codes.code) is the caller's responsibility —
 * both allocators loop with a UNIQUE-collision check.
 */
export function generateReferralCode(seed: string): string {
  const prefix = randomBytes(2).toString('hex').toUpperCase().slice(0, 4);
  const suffix = (
    (seed ?? '').replace(/[^A-Za-z]/g, '').toUpperCase() + 'GHN'
  ).slice(0, 3);
  return `${prefix}${suffix}`;
}
