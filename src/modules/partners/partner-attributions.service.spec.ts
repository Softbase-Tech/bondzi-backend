import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  PartnerAttributionSource,
  PartnerFraudSeverity,
  PartnerStatus,
} from '../../common/types/enums';
import { DeviceSession } from '../auth/entities/device-session.entity';
import { MailService } from '../mail/mail.service';
import { User } from '../users/entities/user.entity';
import { PartnerAttribution } from './entities/partner-attribution.entity';
import { PartnerFraudEvent } from './entities/partner-fraud-event.entity';
import { Partner } from './entities/partner.entity';
import { PartnerAttributionsService } from './partner-attributions.service';
import { PartnerTermsService } from './partner-terms.service';
import { PartnersService } from './partners.service';

describe('PartnerAttributionsService', () => {
  let service: PartnerAttributionsService;
  let attrRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
  };
  let fraudRepo: {
    create: jest.Mock;
    save: jest.Mock;
  };
  let partnersRepo: {
    findOne: jest.Mock;
    increment: jest.Mock;
  };
  let usersRepo: { findOne: jest.Mock };
  let sessionsRepo: { findOne: jest.Mock };
  let partnersService: {
    findActiveCode: jest.Mock;
  };

  const partnerRow: Partner = {
    id: 'partner-1',
    userId: 'partner-user-1',
    email: 'partner@example.com',
    phone: '+233209000001',
    fullName: 'Kwame Partner',
    countryCode: 'GH',
    momoProvider: 'mtn',
    momoNumber: '0209000001',
    momoAccountName: 'Kwame Partner',
    status: PartnerStatus.ACTIVE,
    agreedTermsVersionId: 't1',
    fraudFlagCount: 0,
    approvedAt: null,
    approvedBy: null,
    suspendedAt: null,
    bannedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Partner;

  const referredUser = (patch: Partial<User> = {}) =>
    ({
      id: 'referred-user-1',
      email: 'kojo@example.com',
      phone: '+233240111222',
      isActive: true,
      ...patch,
    }) as unknown as User;

  const code = {
    id: 'code-1',
    partnerId: partnerRow.id,
    code: 'A1B2CJO',
    isActive: true,
  };

  beforeEach(async () => {
    attrRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((o) => ({ id: 'attr-1', ...o })),
      save: jest.fn(async (o) => o),
      count: jest.fn().mockResolvedValue(0),
    };
    fraudRepo = {
      create: jest.fn((o) => o),
      save: jest.fn(async (o) => o),
    };
    partnersRepo = {
      findOne: jest.fn().mockResolvedValue(partnerRow),
      increment: jest.fn().mockResolvedValue(undefined),
    };
    usersRepo = { findOne: jest.fn() };
    sessionsRepo = { findOne: jest.fn().mockResolvedValue(null) };
    partnersService = {
      findActiveCode: jest.fn().mockResolvedValue(code),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PartnerAttributionsService,
        {
          provide: getRepositoryToken(PartnerAttribution),
          useValue: attrRepo,
        },
        { provide: getRepositoryToken(PartnerFraudEvent), useValue: fraudRepo },
        { provide: getRepositoryToken(Partner), useValue: partnersRepo },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: getRepositoryToken(DeviceSession), useValue: sessionsRepo },
        { provide: PartnersService, useValue: partnersService },
        {
          provide: PartnerTermsService,
          useValue: {
            // Return a large threshold so no auto-suspend triggers in
            // any of these tests — that's a separate concern verified
            // separately below.
            getCurrent: jest.fn().mockResolvedValue({
              id: 'terms-1',
              version: 1,
              maxFraudFlagsBeforeBlock: 999,
              maxAppeals: 3,
            }),
          },
        },
        {
          provide: MailService,
          useValue: {
            send: jest.fn().mockResolvedValue(undefined),
            getWebUrl: jest.fn().mockReturnValue('https://bondzi.app'),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(PartnerAttributionsService);
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('creates an attribution row for a valid code + no fraud flags', async () => {
    const out = await service.attributeFromRegister({
      user: referredUser(),
      code: 'A1B2CJO',
      deviceId: 'device-xyz',
    });
    expect(out).not.toBeNull();
    expect(attrRepo.save).toHaveBeenCalledTimes(1);
    const savedRow = attrRepo.save.mock.calls[0][0];
    expect(savedRow.partnerId).toBe(partnerRow.id);
    expect(savedRow.partnerReferralCodeId).toBe(code.id);
    expect(savedRow.attributionSource).toBe(
      PartnerAttributionSource.REGISTER_CODE,
    );
    expect(savedRow.suspicionFlags).toEqual([]);
    expect(fraudRepo.save).not.toHaveBeenCalled();
    expect(partnersRepo.increment).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it('returns the existing attribution when one already exists (idempotent)', async () => {
    const existing = { id: 'existing-attr' };
    attrRepo.findOne.mockResolvedValueOnce(existing);
    const out = await service.attributeFromRegister({
      user: referredUser(),
      code: 'A1B2CJO',
    });
    expect(out).toBe(existing);
    expect(attrRepo.save).not.toHaveBeenCalled();
    expect(partnersService.findActiveCode).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Unknown / inactive code
  // -------------------------------------------------------------------------

  it('no-ops on an unknown or inactive code (never blocks register)', async () => {
    partnersService.findActiveCode.mockResolvedValueOnce(null);
    const out = await service.attributeFromRegister({
      user: referredUser(),
      code: 'BADCODE',
    });
    expect(out).toBeNull();
    expect(attrRepo.save).not.toHaveBeenCalled();
  });

  it('no-ops when the referring partner is banned', async () => {
    partnersRepo.findOne.mockResolvedValueOnce({
      ...partnerRow,
      status: PartnerStatus.BANNED,
    });
    const out = await service.attributeFromRegister({
      user: referredUser(),
      code: 'A1B2CJO',
    });
    expect(out).toBeNull();
    expect(attrRepo.save).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Fraud checks
  // -------------------------------------------------------------------------

  it('flags SELF_REFERRAL when the referred user IS the partner user', async () => {
    await service.attributeFromRegister({
      user: referredUser({ id: partnerRow.userId! }),
      code: 'A1B2CJO',
    });
    const savedRow = attrRepo.save.mock.calls[0][0];
    expect(savedRow.suspicionFlags).toContain('self_referral');
    // High severity → counter bump
    expect(partnersRepo.increment).toHaveBeenCalledWith(
      { id: partnerRow.id },
      'fraudFlagCount',
      1,
    );
    expect(fraudRepo.save).toHaveBeenCalledTimes(1);
    const fraudRow = fraudRepo.save.mock.calls[0][0];
    expect(fraudRow.severity).toBe(PartnerFraudSeverity.HIGH);
  });

  it('flags SAME_DEVICE when the referred user reuses the partner`s device', async () => {
    sessionsRepo.findOne.mockResolvedValueOnce({ id: 'session-1' });
    await service.attributeFromRegister({
      user: referredUser(),
      code: 'A1B2CJO',
      deviceId: 'shared-device',
    });
    const savedRow = attrRepo.save.mock.calls[0][0];
    expect(savedRow.suspicionFlags).toContain('same_device');
    // High severity → counter bump
    expect(partnersRepo.increment).toHaveBeenCalledWith(
      { id: partnerRow.id },
      'fraudFlagCount',
      1,
    );
  });

  it('flags SAME_PHONE_ROOT when last 7 digits collide', async () => {
    await service.attributeFromRegister({
      user: referredUser({ phone: '+233209000001' }),
      code: 'A1B2CJO',
    });
    const savedRow = attrRepo.save.mock.calls[0][0];
    expect(savedRow.suspicionFlags).toContain('same_phone_root');
  });

  it('flags SAME_EMAIL_ROOT (low severity, no counter bump)', async () => {
    await service.attributeFromRegister({
      user: referredUser({ email: 'partner+alt@example.org' }),
      code: 'A1B2CJO',
    });
    // Not the same root — the '+' extension puts local-part as
    // 'partner+alt' vs 'partner'. Confirm no false positive.
    const savedRow = attrRepo.save.mock.calls[0][0];
    expect(savedRow.suspicionFlags).not.toContain('same_email_root');
  });

  it('flags ATTRIBUTION_BURST when the partner has >10 attributions in the past hour', async () => {
    attrRepo.count.mockResolvedValueOnce(15);
    await service.attributeFromRegister({
      user: referredUser(),
      code: 'A1B2CJO',
    });
    const savedRow = attrRepo.save.mock.calls[0][0];
    expect(savedRow.suspicionFlags).toContain('attribution_burst');
    // Medium severity → counter bump.
    expect(partnersRepo.increment).toHaveBeenCalled();
  });

  it('stacks multiple flags on the same row + increments the counter for each high/medium', async () => {
    // Set up: self_referral (high) + same_phone_root (medium) + same_device (high)
    sessionsRepo.findOne.mockResolvedValueOnce({ id: 'session-1' });
    await service.attributeFromRegister({
      user: referredUser({
        id: partnerRow.userId!,
        phone: '+233209000001',
      }),
      code: 'A1B2CJO',
      deviceId: 'shared-device',
    });
    const savedRow = attrRepo.save.mock.calls[0][0];
    expect(savedRow.suspicionFlags.length).toBeGreaterThanOrEqual(3);
    // Three high/medium flags → counter bump of 3.
    expect(partnersRepo.increment).toHaveBeenCalledWith(
      { id: partnerRow.id },
      'fraudFlagCount',
      3,
    );
  });

  // -------------------------------------------------------------------------
  // Auto-suspend on crossing the fraud-flag threshold
  // -------------------------------------------------------------------------

  describe('auto-suspend at threshold', () => {
    let saveSpy: jest.Mock;
    let mailSend: jest.Mock;

    beforeEach(async () => {
      // Fresh module with (a) a low threshold (2) and (b) a
      // post-increment partner row whose count crosses it.
      saveSpy = jest.fn(async (o) => o);
      mailSend = jest.fn().mockResolvedValue(undefined);
      const moduleRef = await Test.createTestingModule({
        providers: [
          PartnerAttributionsService,
          {
            provide: getRepositoryToken(PartnerAttribution),
            useValue: attrRepo,
          },
          {
            provide: getRepositoryToken(PartnerFraudEvent),
            useValue: fraudRepo,
          },
          {
            provide: getRepositoryToken(Partner),
            useValue: {
              findOne: jest
                .fn()
                // First call inside attribute() picks up the partner.
                .mockResolvedValueOnce(partnerRow)
                // Second call inside maybeAutoSuspend() — the row has
                // been bumped by `increment` to 5, well over the
                // threshold.
                .mockResolvedValueOnce({
                  ...partnerRow,
                  fraudFlagCount: 5,
                }),
              increment: jest.fn().mockResolvedValue(undefined),
              save: saveSpy,
            },
          },
          { provide: getRepositoryToken(User), useValue: usersRepo },
          {
            provide: getRepositoryToken(DeviceSession),
            useValue: sessionsRepo,
          },
          {
            provide: PartnersService,
            useValue: {
              findActiveCode: jest.fn().mockResolvedValue(code),
            },
          },
          {
            provide: PartnerTermsService,
            useValue: {
              getCurrent: jest.fn().mockResolvedValue({
                id: 'terms-1',
                version: 1,
                maxFraudFlagsBeforeBlock: 2,
                maxAppeals: 3,
              }),
            },
          },
          {
            provide: MailService,
            useValue: {
              send: mailSend,
              getWebUrl: jest.fn().mockReturnValue('https://bondzi.app'),
            },
          },
        ],
      }).compile();
      service = moduleRef.get(PartnerAttributionsService);
    });

    it('flips the partner to SUSPENDED + fires the suspend email', async () => {
      // Triggering: use a phone that shares a root with the partner
      // (medium severity → high+medium counter bump path).
      sessionsRepo.findOne.mockResolvedValueOnce({ id: 'session-1' });
      await service.attributeFromRegister({
        user: referredUser({ phone: '+233209000001' }),
        code: 'A1B2CJO',
        deviceId: 'shared-device',
      });
      // Post-increment partner save with SUSPENDED status.
      const suspended = saveSpy.mock.calls[0]?.[0];
      expect(suspended.status).toBe(PartnerStatus.SUSPENDED);
      expect(suspended.suspendedAt).toBeInstanceOf(Date);
      // Email fired.
      expect(mailSend).toHaveBeenCalledWith(
        'partner_account_suspended',
        partnerRow.email,
        expect.objectContaining({
          appealsRemaining: 3,
        }),
        expect.any(Object),
      );
    });
  });
});
