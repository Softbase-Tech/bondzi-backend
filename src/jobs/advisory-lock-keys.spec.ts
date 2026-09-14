import { LockKey, duplicateLockKeys } from './advisory-lock-keys';

/**
 * A duplicated advisory-lock key makes two jobs skip each other whenever
 * their schedules overlap — with no error, no log, and no failed test.
 * That is exactly the class of bug that hides for months, so the registry
 * is asserted rather than trusted.
 */
describe('advisory lock keys', () => {
  it('are unique — a duplicate silently disables one of the two jobs', () => {
    expect(duplicateLockKeys()).toEqual([]);
  });

  it('are distinct from each other in count', () => {
    const values = Object.values(LockKey);
    expect(new Set(values).size).toBe(values.length);
  });

  it('keeps the reporting block reserved and contiguous', () => {
    expect(LockKey.REPORT_SNAPSHOT).toBe(17_005);
    expect(LockKey.REPORT_DAILY).toBe(17_006);
    expect(LockKey.REPORT_WEEKLY).toBe(17_007);
    expect(LockKey.REPORT_MONTHLY).toBe(17_008);
  });
});
