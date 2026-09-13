import { Logger } from '@nestjs/common';
import type { CollectorResult } from './collector.types';

/**
 * Shared plumbing for collectors: timing, and the rule that a collector
 * never throws.
 *
 * `guard` wraps one query. If it fails, the metric is absent (renders as
 * `—`) and the reason lands in `errors` — the section degrades, the report
 * still sends. Letting an exception escape would trade a partially-useful
 * email for no email at all, and a missing report is indistinguishable
 * from a quiet day.
 */
export abstract class BaseCollector {
  protected readonly logger = new Logger(this.constructor.name);

  protected async run<T extends object>(
    fn: (errors: string[]) => Promise<Partial<T>>,
  ): Promise<CollectorResult<T>> {
    const started = Date.now();
    const errors: string[] = [];
    let data: Partial<T> = {};
    try {
      data = await fn(errors);
    } catch (err) {
      // Belt and braces: individual queries are already guarded, so
      // reaching here means something outside them failed.
      errors.push(`${this.constructor.name}: ${(err as Error).message}`);
    }
    return { data, errors, durationMs: Date.now() - started };
  }

  /** Run one query; on failure record the reason and yield `fallback`. */
  protected async guard<T>(
    label: string,
    errors: string[],
    fn: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const msg = `${label}: ${(err as Error).message}`;
      this.logger.warn(`[reports] ${msg}`);
      errors.push(msg);
      return fallback;
    }
  }
}

/**
 * Postgres driver values are strings, numbers, or null — never objects for
 * the columns these helpers read. `asText` makes that assumption explicit
 * so an unexpected object becomes an empty string (and therefore a null
 * metric) rather than the literal "[object Object]" in a report.
 */
function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return '';
}

/** Postgres returns bigint/numeric as strings; NULL as null. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(asText(v));
  return Number.isFinite(n) ? n : null;
}

/** Same, but an absent row means zero rather than unknown (COUNT(*)). */
export function count(v: unknown): number {
  return num(v) ?? 0;
}

/** Collapse `[{k, n}]` rows into a plain record for the snapshot JSON. */
export function toRecord(
  rows: Array<Record<string, unknown>>,
  keyCol: string,
  valCol: string,
  nullKey = 'unknown',
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = r[keyCol];
    out[k === null || k === undefined || k === '' ? nullKey : asText(k)] =
      count(r[valCol]);
  }
  return out;
}
