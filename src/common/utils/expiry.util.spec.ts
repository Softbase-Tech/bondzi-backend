import { parseExpiryMs } from './expiry.util';

describe('parseExpiryMs', () => {
  it('parses milliseconds', () => {
    expect(parseExpiryMs('500ms', 0)).toBe(500);
  });
  it('parses seconds, minutes, hours, days', () => {
    expect(parseExpiryMs('30s', 0)).toBe(30_000);
    expect(parseExpiryMs('15m', 0)).toBe(900_000);
    expect(parseExpiryMs('2h', 0)).toBe(7_200_000);
    expect(parseExpiryMs('30d', 0)).toBe(30 * 86_400_000);
  });
  it('accepts numeric input as ms', () => {
    expect(parseExpiryMs(42, 99)).toBe(42);
  });
  it('falls back on malformed input', () => {
    expect(parseExpiryMs('nonsense', 5)).toBe(5);
    expect(parseExpiryMs(undefined, 7)).toBe(7);
    expect(parseExpiryMs('', 11)).toBe(11);
  });
});
