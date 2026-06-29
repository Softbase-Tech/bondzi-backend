import {
  canonicalUsername,
  daysUntilUsernameCooldownEnds,
  USERNAME_CHANGE_COOLDOWN_DAYS,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  validateUsernameFormat,
} from './username.rules';

/**
 * The validator is the single source of truth for the format rules
 * surfaced across registration, profile-edit, and the public
 * availability endpoint. If anything changes here, the mobile hint
 * copy needs to follow.
 */
describe('validateUsernameFormat', () => {
  it('accepts a typical alphanumeric handle', () => {
    expect(validateUsernameFormat('ekowmensah')).toEqual({ ok: true });
    expect(validateUsernameFormat('Player1')).toEqual({ ok: true });
    expect(validateUsernameFormat('A1B2C3')).toEqual({ ok: true });
  });

  it('rejects strings shorter than the minimum length', () => {
    const result = validateUsernameFormat('abc');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('too_short');
    expect(result.message).toContain(String(USERNAME_MIN_LENGTH));
  });

  it('rejects strings longer than the max length', () => {
    const result = validateUsernameFormat('a'.repeat(USERNAME_MAX_LENGTH + 1));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('too_long');
  });

  it.each([
    ['has a space', 'ekow mensah'],
    ['has an underscore', 'ekow_mensah'],
    ['has a hyphen', 'ekow-mensah'],
    ['has a dot', 'ekow.mensah'],
    ['has a colon', 'ekow:mensah'],
    ['has a semicolon', 'ekow;mensah'],
    ['has a question mark', 'ekow?123'],
    ['has emoji', 'ekow😀'],
    ['has unicode letter', 'ékowmensah'],
  ])('rejects when the input %s', (_label, input) => {
    const result = validateUsernameFormat(input);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_chars');
  });

  it('rejects reserved handles case-insensitively', () => {
    // "support" / "bondzi" / "official" are all ≥ 6 chars so they trip
    // the reserved check rather than the length check.
    expect(validateUsernameFormat('support').reason).toBe('reserved');
    expect(validateUsernameFormat('SUPPORT').reason).toBe('reserved');
    expect(validateUsernameFormat('Bondzi').reason).toBe('reserved');
    expect(validateUsernameFormat('official').reason).toBe('reserved');
  });

  it('trims surrounding whitespace before validating', () => {
    expect(validateUsernameFormat('  player1  ')).toEqual({ ok: true });
  });

  it('refuses non-string inputs without crashing', () => {
    expect(validateUsernameFormat(null).ok).toBe(false);
    expect(validateUsernameFormat(undefined).ok).toBe(false);
    expect(validateUsernameFormat(42).ok).toBe(false);
  });
});

describe('canonicalUsername', () => {
  it('lower-cases and trims', () => {
    expect(canonicalUsername('  EkowMensah ')).toBe('ekowmensah');
  });
});

describe('daysUntilUsernameCooldownEnds', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  it('returns 0 when no prior change exists (first-time back-fill)', () => {
    expect(daysUntilUsernameCooldownEnds(null, new Date())).toBe(0);
  });

  it('returns 0 once the cooldown has fully elapsed', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const changedAt = new Date(
      now.getTime() - (USERNAME_CHANGE_COOLDOWN_DAYS + 1) * DAY_MS,
    );
    expect(daysUntilUsernameCooldownEnds(changedAt, now)).toBe(0);
  });

  it('returns the remaining whole days mid-cooldown', () => {
    const now = new Date('2026-01-31T00:00:00Z');
    // 10 full days have elapsed since changedAt → 80 days remain.
    const changedAt = new Date(now.getTime() - 10 * DAY_MS);
    expect(daysUntilUsernameCooldownEnds(changedAt, now)).toBe(80);
  });

  it('rounds up partial remaining days to err on the safe side', () => {
    const now = new Date('2026-01-31T00:00:00Z');
    // Cooldown ends in 1 hour from now — UI should still say "1 day".
    const changedAt = new Date(
      now.getTime() - (USERNAME_CHANGE_COOLDOWN_DAYS * DAY_MS - HOUR_MS),
    );
    expect(daysUntilUsernameCooldownEnds(changedAt, now)).toBe(1);
  });
});
