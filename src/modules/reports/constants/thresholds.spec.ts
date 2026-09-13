import { evaluate, ratio, worstState, THRESHOLDS } from './thresholds';

/**
 * Two behaviours here decide whether the alert line is trustworthy:
 * volume floors (so a 50%-on-2-attempts rate never pages anyone) and the
 * rule that an unmeasurable metric is `ok`, not `critical`.
 */
describe('ratio', () => {
  it('returns null on a zero denominator — never Infinity', () => {
    expect(ratio(5, 0)).toBeNull();
  });

  it('returns null when either side is unknown', () => {
    expect(ratio(null, 10)).toBeNull();
    expect(ratio(10, null)).toBeNull();
  });

  it('returns null rather than NaN for 0/0', () => {
    expect(ratio(0, 0)).toBeNull();
  });

  it('rejects non-finite inputs', () => {
    expect(ratio(Infinity, 2)).toBeNull();
    expect(ratio(NaN, 2)).toBeNull();
  });

  it('computes an honest ratio otherwise', () => {
    expect(ratio(9, 12)).toBe(0.75);
  });
});

describe('evaluate', () => {
  it('treats an unmeasurable metric as ok, not critical', () => {
    // A collector that timed out must not raise a red alert — doing so
    // trains the reader to ignore the status line.
    expect(evaluate('payment_success_rate', null, 500)).toBe('ok');
  });

  describe('volume floors', () => {
    it('does not evaluate a rate below its floor, however bad it looks', () => {
      // 50% success on 2 attempts is noise, not an incident.
      expect(evaluate('payment_success_rate', 0.5, 2)).toBe('ok');
    });

    it('evaluates once the floor is met', () => {
      expect(evaluate('payment_success_rate', 0.5, 10)).toBe('critical');
      expect(evaluate('payment_success_rate', 0.85, 10)).toBe('warn');
      expect(evaluate('payment_success_rate', 0.99, 10)).toBe('ok');
    });

    it('forces ok when the denominator is missing entirely', () => {
      expect(evaluate('payment_success_rate', 0.1)).toBe('ok');
    });

    it('applies the activation floor the same way', () => {
      expect(evaluate('activation_rate', 0.1, 3)).toBe('ok');
      expect(evaluate('activation_rate', 0.1, 10)).toBe('critical');
    });
  });

  describe('direction', () => {
    it("'below' metrics trip when they fall", () => {
      expect(THRESHOLDS.payment_success_rate.direction).toBe('below');
      expect(evaluate('payment_success_rate', 0.7, 100)).toBe('critical');
    });

    it("'above' metrics trip when they rise", () => {
      expect(THRESHOLDS.ai_spend_day_usd.direction).toBe('above');
      expect(evaluate('ai_spend_day_usd', 12)).toBe('critical');
      expect(evaluate('ai_spend_day_usd', 4)).toBe('warn');
      expect(evaluate('ai_spend_day_usd', 0.5)).toBe('ok');
    });
  });

  it('flags a forecast that will break the monthly cap', () => {
    // 3+ days elapsed, forecast at 110% of cap.
    expect(evaluate('ai_forecast_vs_cap', 1.1, 8)).toBe('critical');
    expect(evaluate('ai_forecast_vs_cap', 0.9, 8)).toBe('warn');
    // …but not on day 2, when the straight-line forecast is still noise.
    expect(evaluate('ai_forecast_vs_cap', 1.1, 2)).toBe('ok');
  });
});

describe('worstState', () => {
  it('reports the worst present', () => {
    expect(worstState(['ok', 'warn', 'critical'])).toBe('critical');
    expect(worstState(['ok', 'warn'])).toBe('warn');
    expect(worstState(['ok', 'ok'])).toBe('ok');
    expect(worstState([])).toBe('ok');
  });
});
