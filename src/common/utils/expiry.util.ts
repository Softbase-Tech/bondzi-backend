/**
 * Parse short duration strings like `15m`, `30d`, `1h` into milliseconds.
 * Supports: ms, s, m, h, d. Falls back to `fallbackMs` if the string is
 * malformed or empty. No external dependency — `ms` semantics are simple.
 */
export function parseExpiryMs(
  value: string | number | undefined,
  fallbackMs: number,
): number {
  if (typeof value === 'number') return value;
  if (!value) return fallbackMs;
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) return fallbackMs;
  const n = parseInt(match[1], 10);
  const unit = (match[2] ?? 'ms') as 'ms' | 's' | 'm' | 'h' | 'd';
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return n * mult;
}
