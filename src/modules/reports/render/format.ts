import type { AlertState, Metric } from '../collectors/collector.types';

/**
 * Formatting primitives shared by the text and HTML renderers.
 *
 * The single rule these enforce: **an unknown value renders as `—`,
 * never as 0.** "Zero signups" and "we could not count signups" demand
 * opposite reactions, and a renderer that silently coerces null to zero
 * turns a broken collector into a false business signal.
 */

export const DASH = '—';

export function n(v: Metric, digits = 0): string {
  if (v === null || !Number.isFinite(v)) return DASH;
  return v.toLocaleString('en-GH', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function pct(v: Metric, digits = 0): string {
  if (v === null || !Number.isFinite(v)) return DASH;
  return `${(v * 100).toFixed(digits)}%`;
}

export function ghs(v: Metric): string {
  return v === null || !Number.isFinite(v) ? DASH : `GHS ${n(v, 2)}`;
}

export function usd(v: Metric, digits = 2): string {
  return v === null || !Number.isFinite(v) ? DASH : `$${v.toFixed(digits)}`;
}

/**
 * Change against a baseline, as a signed percentage.
 *
 * Returns `—` when the baseline is zero rather than "+∞%": going from 0
 * to 3 is not an infinite improvement, it is three.
 */
export function delta(current: Metric, baseline: Metric): string {
  if (current === null || baseline === null) return DASH;
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return DASH;
  if (baseline === 0) return DASH;
  const d = (current - baseline) / Math.abs(baseline);
  const sign = d > 0 ? '+' : '';
  return `${sign}${(d * 100).toFixed(0)}%`;
}

/** Mean of the known values; null when nothing is known. */
export function mean(values: Metric[]): Metric {
  const known = values.filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  if (known.length === 0) return null;
  return known.reduce((a, b) => a + b, 0) / known.length;
}

const BLOCKS = '▁▂▃▄▅▆▇█';

/**
 * Block-character sparkline. Renders identically in the HTML and plain
 * text parts, which is the whole point — no images, no divergence between
 * the two versions of the email.
 */
export function sparkline(values: Metric[]): string {
  const known = values.map((v) =>
    v === null || !Number.isFinite(v) ? null : v,
  );
  const nums = known.filter((v): v is number => v !== null);
  if (nums.length === 0) return DASH;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min;
  return known
    .map((v) => {
      if (v === null) return ' ';
      // A flat series should read as a flat line, not as all-minimum.
      if (span === 0) return BLOCKS[Math.floor(BLOCKS.length / 2)];
      const i = Math.round(((v - min) / span) * (BLOCKS.length - 1));
      return BLOCKS[i];
    })
    .join('');
}

export function statusToken(
  state: AlertState,
  counts: {
    warn: number;
    critical: number;
  },
): string {
  if (state === 'critical') {
    return `🔴 ${counts.critical} critical`;
  }
  if (state === 'warn') {
    return `⚠️ ${counts.warn} warning${counts.warn === 1 ? '' : 's'}`;
  }
  return '✅ healthy';
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * `2026-09-10` → `10 Sep`. Short enough for a subject line.
 *
 * Explicit month names rather than `toLocaleString`: ICU abbreviations
 * vary by Node build and locale data (the same call returns "Sep" on one
 * runtime and "Sept" on another). The subject line is how a report is
 * recognised in an inbox and how it is searched for later, so it must not
 * change shape because a base image was upgraded.
 */
export function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Pad for the fixed-width plain-text layout. */
export function padEnd(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

export function padStart(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

/** Minimal HTML escaping for the few values that reach markup. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
