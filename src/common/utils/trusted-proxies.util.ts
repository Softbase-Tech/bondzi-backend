import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { Logger } from '@nestjs/common';

/**
 * Express `trust proxy` is the difference between knowing the real
 * client IP and locking every user out at once. In our topology the
 * chain is `client → Cloudflare edge → nginx → api`, so two upstream
 * hops add to `X-Forwarded-For` before Express sees it. Express has to
 * be told which of those hops to trust; trusting everything would let
 * an attacker who can reach the origin directly spoof their IP via a
 * crafted X-Forwarded-For header.
 *
 * The Express native shapes for `trust proxy` (number of hops, static
 * CIDR list, or array of keywords) all force us to maintain Cloudflare's
 * IP ranges by hand — those drift on the order of years but they do
 * drift, and the next time they add a /18 we'd silently mis-attribute
 * every request behind it. This manager solves that:
 *
 *   - Baseline list is hardcoded so boot works without network access.
 *   - Background refresh polls Cloudflare's published IP lists every
 *     24h and atomically swaps the BlockList in place. The refresh is
 *     best-effort; on failure we keep using whatever we had.
 *   - Express is wired via the callback form of `trust proxy`, so the
 *     latest list is consulted on every request — no restart needed
 *     when the refresh lands.
 *   - Native `node:net.BlockList` does the CIDR match in sub-µs.
 *
 * Source for the published lists:
 *   https://www.cloudflare.com/ips-v4
 *   https://www.cloudflare.com/ips-v6
 *   (plain text, one CIDR per line, # comments)
 */

const logger = new Logger('TrustedProxyManager');

/**
 * Cloudflare IPv4 ranges, current as of 2026. Refreshed at runtime via
 * `refresh()`; this list is just the bootstrap so the API can start
 * without network access. Keep in sync with https://www.cloudflare.com/ips-v4
 * when bumping for cosmetic reasons — not strictly required because
 * the refresh path will pick up additions.
 */
const BASELINE_CLOUDFLARE_IPV4: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

const BASELINE_CLOUDFLARE_IPV6: readonly string[] = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

/**
 * Local-only ranges we trust unconditionally — nginx and the api
 * container talk to each other across the Docker compose bridge
 * network, which lives in 172.16.0.0/12 by default. Keeping
 * 10.0.0.0/8 + 192.168.0.0/16 in here is harmless: an attacker
 * inside a 10/8 network is already on our LAN, and the public
 * Lightsail interface is on a different prefix.
 */
const LOOPBACK_AND_PRIVATE_IPV4: readonly string[] = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16', // link-local
];

const LOOPBACK_AND_PRIVATE_IPV6: readonly string[] = [
  '::1/128',
  'fc00::/7', // unique-local
  'fe80::/10', // link-local
];

const CLOUDFLARE_IPV4_URL = 'https://www.cloudflare.com/ips-v4';
const CLOUDFLARE_IPV6_URL = 'https://www.cloudflare.com/ips-v6';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const REFRESH_TIMEOUT_MS = 5_000;

export class TrustedProxyManager {
  /**
   * Held inside an object so the per-request `isTrusted` callback always
   * reads the latest snapshot. Hot-swapping the property is atomic in
   * JS — a request that's mid-check either sees the old list or the
   * new list, never a half-built one.
   */
  private blockList: BlockList = new BlockList();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastRefreshAt: Date | null = null;
  private rangeCount = 0;

  constructor() {
    this.rebuild([
      ...BASELINE_CLOUDFLARE_IPV4,
      ...BASELINE_CLOUDFLARE_IPV6,
      ...LOOPBACK_AND_PRIVATE_IPV4,
      ...LOOPBACK_AND_PRIVATE_IPV6,
    ]);
  }

  /**
   * Per-request check. Express passes the immediate hop address; we
   * return true if THAT hop is a trusted proxy (so Express keeps
   * walking back through X-Forwarded-For). The first untrusted hop
   * becomes `req.ip` — that's the real client.
   *
   * Handles the `::ffff:1.2.3.4` IPv4-mapped-IPv6 form Node emits when
   * the listening socket is dual-stack. Without the strip, every
   * incoming IPv4 hop would look like an IPv6 address and miss the
   * IPv4 ranges.
   */
  isTrusted(addr: string | undefined): boolean {
    if (!addr) return false;
    const clean = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
    try {
      if (isIPv4(clean)) return this.blockList.check(clean, 'ipv4');
      if (isIPv6(clean)) return this.blockList.check(clean, 'ipv6');
    } catch {
      // BlockList.check throws on malformed input; treat as untrusted.
    }
    return false;
  }

  /**
   * Pull the latest Cloudflare lists and rebuild the BlockList. Best-
   * effort: any failure (timeout, parse error, empty body) is logged
   * and the current list is left in place. The api never blocks on
   * this fetch.
   */
  async refresh(): Promise<void> {
    try {
      const [v4, v6] = await Promise.all([
        fetchCidrList(CLOUDFLARE_IPV4_URL),
        fetchCidrList(CLOUDFLARE_IPV6_URL),
      ]);
      if (v4.length === 0 && v6.length === 0) {
        logger.warn(
          'Cloudflare IP refresh returned empty lists; keeping previous snapshot',
        );
        return;
      }
      this.rebuild([
        ...v4,
        ...v6,
        ...LOOPBACK_AND_PRIVATE_IPV4,
        ...LOOPBACK_AND_PRIVATE_IPV6,
      ]);
      this.lastRefreshAt = new Date();
      logger.log(
        `Cloudflare IP list refreshed — ${v4.length} IPv4 + ${v6.length} IPv6 ranges`,
      );
    } catch (err) {
      logger.warn(
        `Cloudflare IP refresh failed (keeping previous list): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Fire an initial refresh (non-blocking) and schedule a daily one.
   * The timer is `unref()`'d so a clean SIGTERM during the wait window
   * doesn't keep the process alive.
   */
  startBackgroundRefresh(): void {
    // Fire-and-forget initial refresh.
    void this.refresh();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  /** Stops the refresh timer (used by tests + graceful shutdown). */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Diagnostic snapshot — exposed for logs / future /admin/health. */
  snapshot(): { rangeCount: number; lastRefreshAt: Date | null } {
    return { rangeCount: this.rangeCount, lastRefreshAt: this.lastRefreshAt };
  }

  private rebuild(cidrs: readonly string[]): void {
    const fresh = new BlockList();
    let added = 0;
    for (const cidr of cidrs) {
      if (addCidr(fresh, cidr)) added += 1;
    }
    this.blockList = fresh;
    this.rangeCount = added;
  }
}

function addCidr(blockList: BlockList, cidr: string): boolean {
  const [net, prefixStr] = cidr.split('/');
  if (!net) return false;
  const isV6 = isIPv6(net);
  const defaultPrefix = isV6 ? 128 : 32;
  const prefix = prefixStr !== undefined ? Number(prefixStr) : defaultPrefix;
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > defaultPrefix) {
    return false;
  }
  try {
    blockList.addSubnet(net, prefix, isV6 ? 'ipv6' : 'ipv4');
    return true;
  } catch {
    return false;
  }
}

async function fetchCidrList(url: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    return parseCidrList(text);
  } finally {
    clearTimeout(timer);
  }
}

function parseCidrList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}
