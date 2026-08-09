import { TrustedProxyManager } from './trusted-proxies.util';

/**
 * Locks in the baseline behavior so the api boots safely WITHOUT
 * needing the background refresh to land first:
 *
 *  - Cloudflare ranges in the hardcoded baseline match.
 *  - Loopback + Docker bridge ranges match (nginx → api hop).
 *  - Arbitrary public IPs do NOT match (so a direct origin hit with
 *    a forged X-Forwarded-For is correctly rejected).
 *  - IPv4-mapped-IPv6 form is normalized before lookup.
 */

describe('TrustedProxyManager', () => {
  let mgr: TrustedProxyManager;

  beforeEach(() => {
    mgr = new TrustedProxyManager();
  });

  afterEach(() => {
    mgr.stop();
  });

  it('trusts hardcoded Cloudflare IPv4 ranges out of the box', () => {
    // 104.16.0.0/13 — one of the largest Cloudflare blocks.
    expect(mgr.isTrusted('104.16.0.1')).toBe(true);
    expect(mgr.isTrusted('104.23.255.254')).toBe(true);
    // 172.64.0.0/13
    expect(mgr.isTrusted('172.64.42.42')).toBe(true);
  });

  it('trusts hardcoded Cloudflare IPv6 ranges', () => {
    expect(mgr.isTrusted('2606:4700::1')).toBe(true);
    expect(mgr.isTrusted('2400:cb00::abcd')).toBe(true);
  });

  it('trusts loopback and the Docker compose bridge network', () => {
    expect(mgr.isTrusted('127.0.0.1')).toBe(true);
    expect(mgr.isTrusted('::1')).toBe(true);
    // Docker compose default bridge is in 172.16.0.0/12.
    expect(mgr.isTrusted('172.18.0.5')).toBe(true);
  });

  it('rejects arbitrary public IPs (no spoofed X-Forwarded-For wins)', () => {
    expect(mgr.isTrusted('8.8.8.8')).toBe(false);
    expect(mgr.isTrusted('1.1.1.1')).toBe(false); // CF resolver, NOT a CF edge
    expect(mgr.isTrusted('2001:db8::1')).toBe(false);
  });

  it('normalizes IPv4-mapped-IPv6 form before the lookup', () => {
    // Node emits `::ffff:104.16.0.1` for IPv4 traffic on a dual-stack
    // socket. Without the strip this would miss the IPv4 ranges.
    expect(mgr.isTrusted('::ffff:104.16.0.1')).toBe(true);
    expect(mgr.isTrusted('::ffff:127.0.0.1')).toBe(true);
    expect(mgr.isTrusted('::ffff:8.8.8.8')).toBe(false);
  });

  it('returns false for empty or malformed input rather than throwing', () => {
    expect(mgr.isTrusted(undefined)).toBe(false);
    expect(mgr.isTrusted('')).toBe(false);
    expect(mgr.isTrusted('not-an-ip')).toBe(false);
  });

  it('exposes a diagnostic snapshot of the active range count', () => {
    const snap = mgr.snapshot();
    // 15 IPv4 + 7 IPv6 Cloudflare + 5 IPv4 local + 3 IPv6 local = 30.
    expect(snap.rangeCount).toBe(30);
    expect(snap.lastRefreshAt).toBeNull();
  });
});
