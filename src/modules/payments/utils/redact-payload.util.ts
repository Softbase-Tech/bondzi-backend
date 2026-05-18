/**
 * Scrubs PII from a Paystack (and Paystack-shaped) webhook payload
 * before it's surfaced to an admin or stored anywhere the application
 * tier doesn't need the original value.
 *
 * Threat model:
 *   - Admin dashboard renders raw rows from payment_events for
 *     debugging. Customer email / phone / card pan partials should
 *     not appear in that view — admins triage refunds, not lookup PII.
 *   - A future export of the admin response (CSV / Notion) would
 *     otherwise carry email / phone / last4 into untracked storage.
 *
 * Strategy:
 *   - Walk the JSON tree, replace values at known PII paths with the
 *     literal '[REDACTED]'. Keep enough context for triage:
 *     reference, amount, status, channel, paid_at all stay intact.
 *   - Path matching is name-based (case-insensitive), not position-
 *     based, so payload-shape changes from Paystack don't bypass the
 *     redactor.
 *
 * NOT a replacement for storing redacted payloads at the source —
 * raw rows in payment_events retain the original payload (we need
 * it for forensics + future audit). This helper is the OUTBOUND
 * gate when handing a row to a human.
 */

const PII_KEYS = new Set([
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
  'city',
  'street',
  'postal_code',
  'postcode',
  'card_number',
  'card_pan',
  'pan',
  'last4',
  'cvv',
  'cvc',
  'bin',
  'account_number',
  'iban',
  'ssn',
  'national_id',
  'passport',
  'dob',
  'date_of_birth',
  // Paystack's authorization object carries the bank + country which
  // together with last4 = PCI-adjacent — strip wholesale.
  'authorization_code',
  'signature',
  'reusable',
  'ip_address',
]);

const REDACTED = '[REDACTED]';

export function redactPaymentPayload(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactPaymentPayload);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEYS.has(k.toLowerCase())) {
        out[k] = REDACTED;
      } else {
        out[k] = redactPaymentPayload(v);
      }
    }
    return out;
  }
  return value;
}
