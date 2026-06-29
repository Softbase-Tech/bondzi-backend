import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verify Resend (Svix) webhook signatures.
 * @see https://docs.svix.com/receiving/verifying-payloads/how
 */
export function verifySvixWebhook(
  rawBody: Buffer | string,
  headers: {
    'svix-id'?: string | string[];
    'svix-timestamp'?: string | string[];
    'svix-signature'?: string | string[];
  },
  secret: string,
  maxAgeSeconds = 300,
): boolean {
  const msgId = headerOne(headers['svix-id']);
  const timestamp = headerOne(headers['svix-timestamp']);
  const signatureHeader = headerOne(headers['svix-signature']);
  if (!msgId || !timestamp || !signatureHeader || !secret) return false;

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (age > maxAgeSeconds) return false;

  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const signed = `${msgId}.${timestamp}.${body}`;
  const key = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const keyBuf = Buffer.from(key, 'base64');
  const expected = createHmac('sha256', keyBuf).update(signed).digest('base64');

  const parts = signatureHeader.split(' ');
  for (const part of parts) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    } catch {
      /* continue */
    }
  }
  return false;
}

function headerOne(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}
