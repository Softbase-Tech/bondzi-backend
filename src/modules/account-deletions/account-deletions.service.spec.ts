import { NotFoundException } from '@nestjs/common';
import { AccountDeletionsService } from './account-deletions.service';
import { AccountDeletionStatus } from '../../common/types/enums';

/**
 * Focuses on the user-facing entry point (DELETE /users/me → schedule).
 * The daily sweep is query-builder heavy and covered by integration testing.
 */
describe('AccountDeletionsService.scheduleUserRequested', () => {
  const makeService = (overrides: { user?: unknown; existing?: unknown }) => {
    const deletionsRepo = {
      findOne: jest.fn().mockResolvedValue(overrides.existing ?? null),
      create: jest.fn((r: unknown) => r),
      save: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const usersRepo = {
      findOne: jest.fn().mockResolvedValue(overrides.user ?? null),
    };
    const sessionsRepo = { delete: jest.fn().mockResolvedValue(undefined) };
    const mail = { send: jest.fn().mockResolvedValue(undefined) };
    const service = new AccountDeletionsService(
      deletionsRepo as never,
      usersRepo as never,
      sessionsRepo as never,
      {} as never,
      mail as never,
    );
    return { service, deletionsRepo, usersRepo, sessionsRepo };
  };

  it('throws when the user does not exist', async () => {
    const { service } = makeService({ user: null });
    await expect(service.scheduleUserRequested('u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('schedules a 90-day deletion and signs the user out', async () => {
    const { service, deletionsRepo, sessionsRepo } = makeService({
      user: { id: 'u1' },
    });
    const before = Date.now();
    const { deleteAfter } = await service.scheduleUserRequested('u1');

    // ~90 days out (allow a few seconds of test drift).
    const ninetyDays = 90 * 24 * 3600 * 1000;
    expect(deleteAfter.getTime()).toBeGreaterThanOrEqual(
      before + ninetyDays - 5000,
    );
    expect(deleteAfter.getTime()).toBeLessThanOrEqual(
      Date.now() + ninetyDays + 5000,
    );
    expect(deletionsRepo.save).toHaveBeenCalledTimes(1);
    const saved = deletionsRepo.create.mock.calls[0][0] as {
      reason: string;
      status: string;
    };
    expect(saved.reason).toBe('user_requested');
    expect(saved.status).toBe(AccountDeletionStatus.SCHEDULED);
    // Signed out everywhere.
    expect(sessionsRepo.delete).toHaveBeenCalledWith({ userId: 'u1' });
  });

  it('is idempotent — an existing schedule is returned and re-signs out', async () => {
    const existingDate = new Date(Date.now() + 1000);
    const { service, deletionsRepo, sessionsRepo } = makeService({
      user: { id: 'u1' },
      existing: {
        id: 'ad1',
        deleteAfter: existingDate,
        status: AccountDeletionStatus.SCHEDULED,
      },
    });
    const { deleteAfter } = await service.scheduleUserRequested('u1');
    expect(deleteAfter).toBe(existingDate);
    // No new row created.
    expect(deletionsRepo.save).not.toHaveBeenCalled();
    // Still revokes sessions (idempotent sign-out).
    expect(sessionsRepo.delete).toHaveBeenCalledWith({ userId: 'u1' });
  });
});
