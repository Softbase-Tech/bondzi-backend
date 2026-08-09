import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { ExamType } from '../../common/types/enums';
import type { Request } from 'express';

/**
 * Thin tests for the AuthController. The service layer is tested separately;
 * this file checks the wire-up that lives only here:
 *   - pickDeviceId precedence (header > body, header wins)
 *   - Device ID is required (controller throws before hitting the service)
 *   - The controller actually forwards the right shape to AuthService
 *   - Logout decodes the JWT `exp` claim
 *   - checkReferral normalises input (trim + uppercase) and short-circuits empty codes
 */

function makeReq(
  headers: Record<string, string | string[] | undefined> = {},
  ip = '1.2.3.4',
): Request {
  return { headers, ip } as unknown as Request;
}

describe('AuthController', () => {
  let controller: AuthController;
  let auth: jest.Mocked<AuthService>;

  beforeEach(async () => {
    auth = {
      register: jest.fn(),
      login: jest.fn(),
      sendOtp: jest.fn(),
      verifyOtp: jest.fn(),
      googleSignIn: jest.fn(),
      refresh: jest.fn(),
      logout: jest.fn(),
      logoutAll: jest.fn(),
      getMe: jest.fn(),
      checkReferralCode: jest.fn(),
      updateExamType: jest.fn(),
    } as unknown as jest.Mocked<AuthService>;

    const users = {
      checkUsernameAvailability: jest.fn(),
      updateUsername: jest.fn(),
    } as unknown as jest.Mocked<UsersService>;

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: UsersService, useValue: users },
      ],
    }).compile();

    controller = moduleRef.get(AuthController);
  });

  // ----------------------- pickDeviceId precedence -----------------------

  it('prefers X-Device-ID header over body', async () => {
    const req = makeReq({ 'x-device-id': 'from-header' });
    await controller.login(
      { email: 'a@b.com', password: 'pw', deviceId: 'from-body' } as never,
      req,
    );
    expect(auth.login).toHaveBeenCalledWith(
      // Identifier is now an object — controller forwards both
      // `email` and `phone` so the service can route on whichever
      // was supplied.
      expect.objectContaining({ email: 'a@b.com' }),
      'pw',
      expect.objectContaining({ deviceId: 'from-header' }),
    );
  });

  it('falls back to body deviceId when header is missing', async () => {
    await controller.login(
      { email: 'a@b.com', password: 'pw', deviceId: 'from-body' } as never,
      makeReq(),
    );
    expect(auth.login).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.com' }),
      'pw',
      expect.objectContaining({ deviceId: 'from-body' }),
    );
  });

  it('throws when neither header nor body supplies a deviceId', () => {
    // pickDeviceId throws synchronously inside the controller method —
    // the rejection happens before the service is touched.
    expect(() =>
      controller.login(
        { email: 'a@b.com', password: 'pw' } as never,
        makeReq(),
      ),
    ).toThrow(BadRequestException);
    expect(auth.login).not.toHaveBeenCalled();
  });

  // --------------------------- forwarding ---------------------------

  it('register forwards body + device + request context to the service', async () => {
    auth.register.mockResolvedValue({ user: { id: 'u' } } as never);
    await controller.register(
      {
        fullName: 'Kofi',
        email: 'k@example.com',
        password: 'pw',
        examType: ExamType.WASSCE,
        formLevel: 3,
      } as never,
      makeReq({ 'x-device-id': 'dev', 'user-agent': 'jest' }),
    );
    const [dto, ctx] = auth.register.mock.calls[0];
    expect(dto.deviceId).toBe('dev');
    expect(ctx).toEqual({ ip: '1.2.3.4', userAgent: 'jest' });
  });

  it('sendOtp forwards only the phone number', async () => {
    await controller.sendOtp({ phone: '+233500000000' } as never);
    expect(auth.sendOtp).toHaveBeenCalledWith('+233500000000');
  });

  // ----------------------------- logout -----------------------------

  it('logout decodes the JWT exp claim and forwards jti + exp + did to the service', async () => {
    const exp = Math.floor(Date.now() / 1000) + 900;
    const payload = Buffer.from(JSON.stringify({ exp })).toString('base64');
    const token = `header.${payload}.sig`;
    await controller.logout(
      { id: 'u', jti: 'jti-1', did: 'd1' } as never,
      makeReq({ authorization: `Bearer ${token}` }),
    );
    // Under per-device the deviceId flows through so only this
    // device's session is closed.
    expect(auth.logout).toHaveBeenCalledWith('u', 'jti-1', exp, 'd1');
  });

  it('logout tolerates a malformed token (exp left undefined)', async () => {
    await controller.logout(
      { id: 'u', jti: 'jti-1', did: 'd1' } as never,
      makeReq({ authorization: 'Bearer not-a-jwt' }),
    );
    expect(auth.logout).toHaveBeenCalledWith('u', 'jti-1', undefined, 'd1');
  });

  // ------------------------- checkReferral -------------------------

  it('checkReferral short-circuits on empty input without calling the service', async () => {
    expect(await controller.checkReferral('   ')).toEqual({ valid: false });
    expect(auth.checkReferralCode).not.toHaveBeenCalled();
  });

  it('checkReferral upper-cases and trims before forwarding', async () => {
    auth.checkReferralCode.mockResolvedValue({ valid: true });
    await controller.checkReferral(' pm-aaaa-jan ');
    expect(auth.checkReferralCode).toHaveBeenCalledWith('AAAAJAN');
  });
});
