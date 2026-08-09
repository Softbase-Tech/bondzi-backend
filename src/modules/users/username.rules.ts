/**
 * Single source of truth for username format rules. Shared by the
 * register DTO, the update-username flow, and the availability check
 * so the same input is accepted or rejected everywhere identically.
 *
 * Spec (from the product brief):
 *   • length ≥ 6
 *   • alphanumeric only — no spaces, hyphens, underscores, dots,
 *     colons, semicolons, question marks, or any other symbol
 *   • case-insensitive uniqueness across the table
 *
 * We don't lower-case on save (so users see "Ekow" if they typed it
 * that way) but the unique index runs on `lower(username)` — see
 * migration 1940. Comparisons in the service layer use lower-case too.
 */

export const USERNAME_MIN_LENGTH = 6;
export const USERNAME_MAX_LENGTH = 24;

/** Letters and digits only. Bounded explicitly so a 200-char paste
 * doesn't slip past `Matches`. */
export const USERNAME_REGEX = /^[A-Za-z0-9]+$/;

/**
 * Reserved handles we never let users claim — confusable with system
 * pages, support handles, or admin routes. Compared case-insensitively.
 * Add freely; entries don't require a migration.
 */
const RESERVED_USERNAMES = new Set<string>([
  'admin',
  'administrator',
  'root',
  'support',
  'help',
  'staff',
  'bondzi',
  'passmaster',
  'system',
  'official',
  'moderator',
  'mod',
  'security',
  'me',
  'null',
  'undefined',
]);

export type UsernameFormatError =
  | 'too_short'
  | 'too_long'
  | 'invalid_chars'
  | 'reserved';

export interface UsernameFormatResult {
  ok: boolean;
  /** Populated only when `ok` is false. */
  reason?: UsernameFormatError;
  /** Human-readable message safe to surface on the client. */
  message?: string;
}

const FORMAT_HINT =
  'Usernames must be at least 6 characters, letters and numbers only — no spaces or symbols.';

export function validateUsernameFormat(input: unknown): UsernameFormatResult {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'invalid_chars', message: FORMAT_HINT };
  }
  const trimmed = input.trim();
  if (trimmed.length < USERNAME_MIN_LENGTH) {
    return {
      ok: false,
      reason: 'too_short',
      message: `Username must be at least ${USERNAME_MIN_LENGTH} characters.`,
    };
  }
  if (trimmed.length > USERNAME_MAX_LENGTH) {
    return {
      ok: false,
      reason: 'too_long',
      message: `Username must be at most ${USERNAME_MAX_LENGTH} characters.`,
    };
  }
  if (!USERNAME_REGEX.test(trimmed)) {
    return { ok: false, reason: 'invalid_chars', message: FORMAT_HINT };
  }
  if (RESERVED_USERNAMES.has(trimmed.toLowerCase())) {
    return {
      ok: false,
      reason: 'reserved',
      message: 'This username is reserved. Please choose another.',
    };
  }
  return { ok: true };
}

/** Lower-cased canonical form used for uniqueness comparison. */
export function canonicalUsername(input: string): string {
  return input.trim().toLowerCase();
}

/** Cooldown between consecutive username changes (back-fill is free). */
export const USERNAME_CHANGE_COOLDOWN_DAYS = 90;

export function daysUntilUsernameCooldownEnds(
  lastChangedAt: Date | null,
  now: Date,
): number {
  if (!lastChangedAt) return 0;
  const elapsedMs = now.getTime() - lastChangedAt.getTime();
  const cooldownMs = USERNAME_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  if (elapsedMs >= cooldownMs) return 0;
  return Math.ceil((cooldownMs - elapsedMs) / (24 * 60 * 60 * 1000));
}
