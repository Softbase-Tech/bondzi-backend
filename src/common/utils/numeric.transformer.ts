import type { ValueTransformer } from 'typeorm';

/**
 * TypeORM hands `numeric` Postgres columns back as JS strings to avoid
 * silent float-precision loss for arbitrary-precision values. For our
 * money columns (precision 10, scale 2 — well within Number.MAX_SAFE_INTEGER
 * cents) the safety isn't material; the practical cost is that every
 * caller has to wrap reads in `Number(...)`. Callers occasionally
 * forgot, and you'd get string-coerced arithmetic like `"5.00" + 1 === "5.001"`.
 *
 * This transformer parses on read and stringifies on write, so the
 * entity property is always a JS number. NaN and non-finite values
 * round-trip as null so a bad write surfaces as a NOT NULL violation
 * (the offending row is rejected before it lands) rather than as a
 * corrupted balance.
 */
export class NumericColumnTransformer implements ValueTransformer {
  to(value: number | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (!Number.isFinite(value)) return null;
    return value.toString();
  }

  from(value: string | null): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
}

export const numericTransformer = new NumericColumnTransformer();
