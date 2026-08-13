import { Test } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AccountDeletionsService } from '../account-deletions/account-deletions.service';

/** Pure pass-through controller — confirm every endpoint takes the user id
 *  from `@CurrentUser` (not the body / query) and forwards untouched. */
describe('UsersController', () => {
  let controller: UsersController;
  let users: jest.Mocked<UsersService>;
  let accountDeletions: jest.Mocked<AccountDeletionsService>;

  beforeEach(async () => {
    users = {
      getMe: jest.fn(),
      updateProfile: jest.fn(),
      changePassword: jest.fn(),
      softDelete: jest.fn(),
      getProgress: jest.fn(),
      getStats: jest.fn(),
    } as unknown as jest.Mocked<UsersService>;
    accountDeletions = {
      scheduleUserRequested: jest.fn(),
    } as unknown as jest.Mocked<AccountDeletionsService>;

    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: users },
        { provide: AccountDeletionsService, useValue: accountDeletions },
      ],
    }).compile();
    controller = moduleRef.get(UsersController);
  });

  it('GET /users/me forwards the authenticated user id', () => {
    controller.me({ id: 'user-1' } as never);
    expect(users.getMe).toHaveBeenCalledWith('user-1');
  });

  it('PATCH /users/me forwards user id + body', () => {
    controller.update(
      { id: 'user-1' } as never,
      { region: 'Greater Accra' } as never,
    );
    expect(users.updateProfile).toHaveBeenCalledWith('user-1', {
      region: 'Greater Accra',
    });
  });

  it('PATCH /users/me/password forwards the DTO and awaits the service', async () => {
    await controller.changePassword(
      { id: 'user-1' } as never,
      { currentPassword: 'a', newPassword: 'b' } as never,
    );
    expect(users.changePassword).toHaveBeenCalledWith('user-1', {
      currentPassword: 'a',
      newPassword: 'b',
    });
  });

  it('DELETE /users/me schedules a user-requested deletion', async () => {
    await controller.requestDeletion({ id: 'user-1' } as never);
    expect(accountDeletions.scheduleUserRequested).toHaveBeenCalledWith(
      'user-1',
    );
  });

  it('GET /users/me/progress forwards the user id', () => {
    controller.progress({ id: 'user-1' } as never);
    expect(users.getProgress).toHaveBeenCalledWith('user-1');
  });

  it('GET /users/me/stats forwards the user id', () => {
    controller.stats({ id: 'user-1' } as never);
    expect(users.getStats).toHaveBeenCalledWith('user-1');
  });
});
