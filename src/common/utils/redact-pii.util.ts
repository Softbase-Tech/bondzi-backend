/**
 * Generic PII scrubber for any JSON-ish blob about to be persisted to
 * an immutable audit log or surfaced to an admin view.
 *
 * Audit rows live forever. If we log a row containing `email`,
 * `passwordHash`, or `phone` in oldValue/newValue, those values
 * survive every retention policy except the one that drops the
 * whole table. That's a long tail of PII exposure for the value of
 * "we already wrote a separate users entry for this delta."
 *
 * Strategy:
 *   - Walk the object; replace values at known PII keys with
 *     '[REDACTED]'. Match by lowercase key name to dodge camelCase
 *     vs snake_case drift.
 *   - Keep IDs (referrals etc) intact — they're useful for joining
 *     against current state without exposing the underlying PII.
 *   - Tokens / secrets / signatures get scrubbed wholesale.
 *
 * The shape mirrors redactPaymentPayload (one tool per concern) but
 * uses a tighter key set; audit deltas don't typically contain card
 * data, so the card-PCI keys are omitted.
 */

const AUDIT_PII_KEYS = new Set([
  // Direct user identifiers
  'email',
  'phone',
  'mobile',
  'first_name',
  'firstname',
  'last_name',
  'lastname',
  'full_name',
  'fullname',
  'name',
  'address',
  'date_of_birth',
  'dob',
  'national_id',
  'passport',
  'ssn',
  // Credentials & secrets
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'access_token',
  'refresh_token',
  'reset_token',
  'otp',
  'verification_code',
  'api_key',
  'apikey',
  'secret',
  'signature',
  'authorization',
  'authorization_code',
  // Network / device fingerprint
  'ip',
  'ip_address',
  'user_agent',
  'fcm_token',
  'device_id',
]);

const REDACTED = '[REDACTED]';

export function redactPii(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactPii);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (AUDIT_PII_KEYS.has(k.toLowerCase())) {
        out[k] = REDACTED;
      } else {
        out[k] = redactPii(v);
      }
    }
    return out;
  }
  return value;
}
