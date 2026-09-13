import { DASH, delta, ghs, mean, n, pct, sparkline, usd } from './format';

/**
 * The formatters carry one rule: an unknown value prints `—`, never 0.
 * "Zero signups" and "we could not count signups" demand opposite
 * reactions, and a renderer that quietly turns null into 0 converts a
 * broken collector into a false business signal.
 */
describe('null discipline', () => {
  it('renders every unknown as a dash, not a zero', () => {
    expect(n(null)).toBe(DASH);
    expect(pct(null)).toBe(DASH);
    expect(ghs(null)).toBe(DASH);
    expect(usd(null)).toBe(DASH);
  });

  it('renders a real zero as zero', () => {
    // The distinction the whole rule exists to protect.
    expect(n(0)).toBe('0');
    expect(usd(0)).toBe('$0.00');
  });

  it('refuses non-finite values', () => {
    expect(n(Infinity)).toBe(DASH);
    expect(n(NaN)).toBe(DASH);
  });
});

describe('delta', () => {
  it('is a dash against a zero baseline, not +∞%', () => {
    // Going 0 → 3 is not an infinite improvement.
    expect(delta(3, 0)).toBe(DASH);
  });

  it('signs the direction', () => {
    expect(delta(120, 100)).toBe('+20%');
    expect(delta(80, 100)).toBe('-20%');
  });

  it('is a dash when either side is unknown', () => {
    expect(delta(null, 100)).toBe(DASH);
    expect(delta(100, null)).toBe(DASH);
  });
});

describe('mean', () => {
  it('ignores unknowns rather than treating them as zero', () => {
    expect(mean([10, null, 20])).toBe(15);
  });

  it('is null when nothing is known', () => {
    expect(mean([null, null])).toBeNull();
  });
});

describe('sparkline', () => {
  it('is a dash when the series is entirely unknown', () => {
    expect(sparkline([null, null])).toBe(DASH);
  });

  it('renders a flat series as a flat line, not all-minimum', () => {
    const s = sparkline([5, 5, 5]);
    expect(new Set(s.split(''))).toHaveProperty('size', 1);
    expect(s).not.toBe('▁▁▁');
  });

  it('maps the range across the block characters', () => {
    const s = sparkline([0, 50, 100]);
    expect(s.startsWith('▁')).toBe(true);
    expect(s.endsWith('█')).toBe(true);
    expect(s).toHaveLength(3);
  });

  it('leaves a gap for an unknown point instead of dropping it', () => {
    // Dropping would shift every later point one column left and make the
    // sparkline lie about when something happened.
    expect(sparkline([1, null, 3])).toHaveLength(3);
  });
});
